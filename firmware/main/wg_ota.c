// Authenticated MQTT carries fixed-size chunks. A pinned ECDSA P-256 key signs
// the canonical manifest; SHA-256 covers every byte written to the OTA slot.
// Boot confirmation is an explicit, expiring administrator action.
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_ota_ops.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "mbedtls/base64.h"
#include "psa/crypto.h"
#include "provisioning.h"
#include "wg_ota.h"

typedef struct {
  uint32_t version, target_address, previous_address;
  uint64_t highest_sequence, candidate_sequence;
  int64_t deadline;
  char active_release[37], previous_release[37], candidate_release[37];
  char test_command[37], last_command[37], last_status[20];
  volatile uint8_t pending;
} ota_record_t;
static ota_record_t record;
static nvs_handle_t storage;
static wg_ota_sender_t send_message;
static wg_ota_ack_t acknowledge;
static esp_ota_handle_t download;
static bool downloading, sensor_ok, publish_ok;
static volatile bool boot_trial;
static size_t expected_size, position;
static unsigned char expected_hash[32];
static psa_hash_operation_t image_hash = PSA_HASH_OPERATION_INIT;
static int64_t last_request, started;

static const char *str(cJSON *o, const char *key) { cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key); return cJSON_IsString(v) ? v->valuestring : NULL; }
static bool bounded_text(const char *s, size_t n) { return s && strlen(s) < n && !strchr(s, '\n') && !strchr(s, '\r'); }
static bool number(cJSON *o, const char *key, double low, double high, uint64_t *out) { cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key); if (!cJSON_IsNumber(v) || !isfinite(v->valuedouble) || v->valuedouble < low || v->valuedouble > high || floor(v->valuedouble) != v->valuedouble) return false; *out = (uint64_t)v->valuedouble; return true; }
static bool hex(const char *value, unsigned char *out, size_t n) { if (!value || strlen(value) != n * 2) return false; for (size_t i = 0; i < n; ++i) { int a = value[2*i], b = value[2*i+1]; a = a >= '0' && a <= '9' ? a-'0' : a >= 'a' && a <= 'f' ? a-'a'+10 : -1; b = b >= '0' && b <= '9' ? b-'0' : b >= 'a' && b <= 'f' ? b-'a'+10 : -1; if (a < 0 || b < 0) return false; out[i] = (a << 4) | b; } return true; }
static void save(void) { ESP_ERROR_CHECK(nvs_set_blob(storage, "ota_v1", &record, sizeof(record))); ESP_ERROR_CHECK(nvs_commit(storage)); }
static void status(const char *id, const char *value) { snprintf(record.last_command, sizeof(record.last_command), "%s", id); snprintf(record.last_status, sizeof(record.last_status), "%s", value); save(); acknowledge(id, value); }
static void abort_download(void) { if (downloading) { esp_ota_abort(download); psa_hash_abort(&image_hash); downloading = false; } }
static void reject_download(void) { abort_download(); record.pending = 0; status(record.test_command, "rejected"); }
static void watchdog(void *unused) {
  (void)unused;
  int64_t monotonic_deadline = 0;
  for (;;) {
    if (boot_trial && record.pending) {
      int64_t now = time(NULL), monotonic = esp_timer_get_time();
      if (!monotonic_deadline && now >= WG_MINIMUM_EPOCH) {
        int64_t remaining = record.deadline - now;
        if (remaining < 0) remaining = 0;
        if (remaining > 3600) remaining = 3600;
        monotonic_deadline = monotonic + remaining * 1000000LL;
      }
      if ((now >= WG_MINIMUM_EPOCH && now >= record.deadline) || (monotonic_deadline && monotonic >= monotonic_deadline) || (now < WG_MINIMUM_EPOCH && monotonic - started > 30000000LL)) {
        esp_ota_mark_app_invalid_rollback_and_reboot();
        esp_restart();
      }
    }
    vTaskDelay(pdMS_TO_TICKS(250));
  }
}
void wg_ota_init(nvs_handle_t handle, wg_ota_sender_t sender, wg_ota_ack_t ack) {
  storage = handle; send_message = sender; acknowledge = ack; started = esp_timer_get_time();
  size_t length = sizeof(record); esp_err_t result = nvs_get_blob(storage, "ota_v1", &record, &length);
  if (result == ESP_ERR_NVS_NOT_FOUND) { memset(&record, 0, sizeof(record)); record.version = 1; save(); }
  else if (result != ESP_OK || length != sizeof(record) || record.version != 1) abort();
  const esp_partition_t *running = esp_ota_get_running_partition();
  boot_trial = record.pending && record.target_address == running->address;
  if (record.pending && !boot_trial) { record.pending = 0; snprintf(record.last_command, sizeof(record.last_command), "%s", record.test_command); snprintf(record.last_status, sizeof(record.last_status), "rolled_back"); save(); }
  if (xTaskCreate(watchdog, "ota-watchdog", 3072, NULL, 5, NULL) != pdPASS) abort();
}
static bool verify_manifest(cJSON *m, const char *signature) {
  const char *format = str(m,"format"), *station = str(m,"stationId"), *environment = str(m,"environment"), *version = str(m,"version"), *digest = str(m,"sha256");
  uint64_t size, sequence;
  if (!cJSON_IsObject(m) || cJSON_GetArraySize(m) != 7 || !format || strcmp(format,"wg-firmware-1") || !station || strcmp(station,WG_STATION_ID) || !environment || strcmp(environment,WG_ENVIRONMENT) || !bounded_text(version,65) || !number(m,"size",1024,0x180000,&size) || !number(m,"sequence",1,9007199254740991.0,&sequence) || sequence <= record.highest_sequence || !hex(digest, expected_hash, 32)) return false;
  unsigned char public_key[65], sig[64], digest_bytes[32]; size_t sig_len = 0, digest_len = 0;
  if (!hex(WG_OTA_PUBLIC_KEY_HEX, public_key, sizeof(public_key)) || !signature || mbedtls_base64_decode(sig,sizeof(sig),&sig_len,(const unsigned char *)signature,strlen(signature)) || sig_len != sizeof(sig)) return false;
  char canonical[512]; int n = snprintf(canonical,sizeof(canonical),"wg-firmware-1\n%s\n%s\n%s\n%llu\n%llu\n%s\n",station,environment,version,(unsigned long long)sequence,(unsigned long long)size,digest);
  if (n <= 0 || n >= sizeof(canonical) || psa_hash_compute(PSA_ALG_SHA_256,(unsigned char *)canonical,n,digest_bytes,sizeof(digest_bytes),&digest_len) != PSA_SUCCESS) return false;
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT; psa_key_id_t key = 0;
  psa_set_key_type(&attributes,PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1)); psa_set_key_bits(&attributes,256); psa_set_key_usage_flags(&attributes,PSA_KEY_USAGE_VERIFY_HASH); psa_set_key_algorithm(&attributes,PSA_ALG_ECDSA(PSA_ALG_SHA_256));
  if (psa_import_key(&attributes,public_key,sizeof(public_key),&key) != PSA_SUCCESS) return false;
  bool valid = psa_verify_hash(key,PSA_ALG_ECDSA(PSA_ALG_SHA_256),digest_bytes,digest_len,sig,sig_len) == PSA_SUCCESS; psa_destroy_key(key); psa_reset_key_attributes(&attributes);
  if (valid) { expected_size = size; record.candidate_sequence = sequence; }
  return valid;
}
bool wg_ota_command(cJSON *command, const char *id, int64_t deadline, bool configuration_pending) {
  const char *kind = str(command,"kind"), *release = str(command,"releaseId");
  if (!kind || (strcmp(kind,"test_firmware") && strcmp(kind,"commit_firmware") && strcmp(kind,"rollback_firmware"))) return false;
  if (!bounded_text(release,37) || strlen(release) != 36) { acknowledge(id,"rejected"); return true; }
  if (!strcmp(kind,"test_firmware")) {
    if (configuration_pending || record.pending || downloading || !verify_manifest(cJSON_GetObjectItemCaseSensitive(command,"manifest"),str(command,"signature"))) { acknowledge(id,"rejected"); return true; }
    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL), *running = esp_ota_get_running_partition();
    if (!target || expected_size > target->size || esp_ota_begin(target,expected_size,&download) != ESP_OK) { acknowledge(id,"rejected"); return true; }
    image_hash = psa_hash_operation_init();
    if (psa_hash_setup(&image_hash,PSA_ALG_SHA_256) != PSA_SUCCESS) { esp_ota_abort(download); acknowledge(id,"rejected"); return true; }
    record.target_address = target->address; record.previous_address = running->address;
    snprintf(record.previous_release,sizeof(record.previous_release),"%s",record.active_release);
    snprintf(record.candidate_release,sizeof(record.candidate_release),"%s",release); snprintf(record.test_command,sizeof(record.test_command),"%s",id);
    record.deadline = deadline; record.pending = 1; downloading = true; position = 0; last_request = 0;
    status(id,"received");
  } else if (!strcmp(kind,"commit_firmware")) {
    if (!boot_trial || !record.pending || strcmp(release,record.candidate_release) || !sensor_ok || !publish_ok || time(NULL) >= record.deadline || esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) { acknowledge(id,"rejected"); return true; }
    record.highest_sequence = record.candidate_sequence; snprintf(record.active_release,sizeof(record.active_release),"%s",release); record.pending = 0; boot_trial = false; status(id,"applied");
  } else {
    if (strcmp(release,record.candidate_release) || (!record.pending && strcmp(release,record.active_release))) { acknowledge(id,"rejected"); return true; }
    abort_download();
    if (boot_trial) { status(id,"rolled_back"); esp_ota_mark_app_invalid_rollback_and_reboot(); }
    else if (esp_ota_get_running_partition()->address == record.target_address && record.previous_address) {
      const esp_partition_t *previous = esp_partition_find_first(ESP_PARTITION_TYPE_APP,ESP_PARTITION_SUBTYPE_ANY,NULL);
      esp_partition_iterator_t iterator = esp_partition_find(ESP_PARTITION_TYPE_APP,ESP_PARTITION_SUBTYPE_ANY,NULL);
      previous = NULL;
      while (iterator) { const esp_partition_t *p = esp_partition_get(iterator); if (p->address == record.previous_address) { previous = p; break; } iterator = esp_partition_next(iterator); }
      esp_partition_iterator_release(iterator);
      if (!previous || esp_ota_set_boot_partition(previous) != ESP_OK) { acknowledge(id,"rejected"); return true; }
      record.pending = 0; snprintf(record.active_release,sizeof(record.active_release),"%s",record.previous_release); status(id,"rolled_back"); vTaskDelay(pdMS_TO_TICKS(100)); esp_restart();
    } else { record.pending = 0; status(id,"rolled_back"); }
  }
  return true;
}
void wg_ota_data(cJSON *object) {
  const char *release = str(object,"releaseId"), *command = str(object,"commandId"), *data = str(object,"data"); uint64_t offset;
  if (!downloading || !release || strcmp(release,record.candidate_release) || !command || strcmp(command,record.test_command) || !number(object,"offset",0,0x180000,&offset) || offset != position || !data || strlen(data) > 1368) return;
  unsigned char chunk[1024]; size_t length = 0;
  if (mbedtls_base64_decode(chunk,sizeof(chunk),&length,(unsigned char *)data,strlen(data)) || length != (expected_size - position > 1024 ? 1024 : expected_size - position)) { reject_download(); return; }
  if (time(NULL) >= record.deadline || esp_ota_write(download,chunk,length) != ESP_OK || psa_hash_update(&image_hash,chunk,length) != PSA_SUCCESS) { reject_download(); return; }
  position += length;
  if (position == expected_size) {
    unsigned char digest[32]; size_t n = 0;
    if (psa_hash_finish(&image_hash,digest,sizeof(digest),&n) != PSA_SUCCESS || n != 32 || memcmp(digest,expected_hash,32)) { reject_download(); return; }
    downloading = false;
    if (esp_ota_end(download) != ESP_OK) { record.pending = 0; status(record.test_command,"rejected"); return; }
    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (!target || target->address != record.target_address || esp_ota_set_boot_partition(target) != ESP_OK) { record.pending = 0; status(record.test_command,"rejected"); return; }
    save(); esp_restart();
  }
}
void wg_ota_tick(bool connected, bool valid_sensor, bool telemetry_acked, bool new_connection) {
  sensor_ok = sensor_ok || valid_sensor; publish_ok = publish_ok || telemetry_acked;
  if (new_connection && connected && record.last_command[0]) {
    if (boot_trial) status(record.test_command,"testing"); else acknowledge(record.last_command,record.last_status);
  }
  if (downloading && time(NULL) >= record.deadline) { reject_download(); return; }
  if (!connected || !downloading || esp_timer_get_time() - last_request < 100000) return;
  cJSON *request = cJSON_CreateObject(); cJSON_AddNumberToObject(request,"version",1); cJSON_AddStringToObject(request,"commandId",record.test_command); cJSON_AddStringToObject(request,"releaseId",record.candidate_release); cJSON_AddNumberToObject(request,"offset",position);
  char *json = cJSON_PrintUnformatted(request); if (json) { send_message("firmware-request",json); free(json); } cJSON_Delete(request); last_request = esp_timer_get_time();
}
const char *wg_ota_release(void) { return boot_trial ? record.candidate_release : record.active_release; }
const char *wg_ota_ack_release(const char *id) { return !strcmp(id,record.last_command) || !strcmp(id,record.test_command) ? record.candidate_release : NULL; }
bool wg_ota_busy(void) { return record.pending || downloading; }
