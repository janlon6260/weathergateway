#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include "esp_timer.h"
#include "mbedtls/x509_crt.h"
#include "provisioning.h"
#include "wg_credentials.h"
#define CERT_SIZE 1600
extern const char ca_pem[] asm("_binary_ca_pem_start");
extern const char device_pem[] asm("_binary_device_pem_start");
typedef struct { uint32_t version; uint8_t pending; char active[CERT_SIZE], candidate[CERT_SIZE], active_id[37], candidate_id[37], command[37]; int64_t deadline; } credential_record_t;
static credential_record_t record;
static nvs_handle_t storage;
static wg_ota_sender_t send_message;
static wg_ota_ack_t acknowledge;
static int64_t expires, local_deadline, last_request;
static const char *str(cJSON *o,const char *key) { cJSON *v = cJSON_GetObjectItemCaseSensitive(o,key); return cJSON_IsString(v) ? v->valuestring : NULL; }
static void save(void) { ESP_ERROR_CHECK(nvs_set_blob(storage,"credentials_v1",&record,sizeof(record))); ESP_ERROR_CHECK(nvs_commit(storage)); }
static int64_t certificate_expiry(const char *pem) {
  mbedtls_x509_crt certificate; mbedtls_x509_crt_init(&certificate); int64_t result = 0;
  if (!mbedtls_x509_crt_parse(&certificate,(const unsigned char *)pem,strlen(pem)+1)) {
    struct tm stamp = {0}; stamp.tm_year = certificate.valid_to.year-1900; stamp.tm_mon = certificate.valid_to.mon-1; stamp.tm_mday = certificate.valid_to.day; stamp.tm_hour = certificate.valid_to.hour; stamp.tm_min = certificate.valid_to.min; stamp.tm_sec = certificate.valid_to.sec; result = mktime(&stamp);
  }
  mbedtls_x509_crt_free(&certificate); return result;
}
void wg_credentials_init(nvs_handle_t nvs, wg_ota_sender_t sender, wg_ota_ack_t ack) {
  storage = nvs; send_message = sender; acknowledge = ack;
  size_t length = sizeof(record); esp_err_t result = nvs_get_blob(storage,"credentials_v1",&record,&length);
  if (result == ESP_ERR_NVS_NOT_FOUND) { memset(&record,0,sizeof(record)); record.version = 1; snprintf(record.active_id,sizeof(record.active_id),"%s",WG_CERTIFICATE_ID); save(); }
  else if (result != ESP_OK || length != sizeof(record) || record.version != 1) abort();
  if (record.pending) { record.pending = 0; save(); }
  expires = certificate_expiry(wg_credentials_certificate());
}
const char *wg_credentials_certificate(void) { return record.pending ? record.candidate : record.active[0] ? record.active : device_pem; }
const char *wg_credentials_id(void) { return record.pending ? record.candidate_id : record.active_id; }
bool wg_credentials_pending(void) { return record.pending; }
bool wg_credentials_stage(cJSON *command,const char *id,int64_t deadline,bool busy) {
  const char *certificate = str(command,"certificate"), *new_id = str(command,"certificateId"), *previous = str(command,"previousCertificateId");
  if (busy || record.pending || !certificate || strlen(certificate) >= CERT_SIZE || !new_id || strlen(new_id) != 36 || !previous || strcmp(previous,record.active_id)) return false;
  mbedtls_x509_crt candidate, ca; mbedtls_x509_crt_init(&candidate); mbedtls_x509_crt_init(&ca); uint32_t flags = 0;
  bool valid = !mbedtls_x509_crt_parse(&candidate,(const unsigned char *)certificate,strlen(certificate)+1) && !mbedtls_x509_crt_parse(&ca,(const unsigned char *)ca_pem,strlen(ca_pem)+1) && !mbedtls_x509_crt_verify(&candidate,&ca,NULL,NULL,&flags,NULL,NULL);
  mbedtls_x509_crt_free(&candidate); mbedtls_x509_crt_free(&ca);
  if (!valid || certificate_expiry(certificate) <= time(NULL)+86400) return false;
  snprintf(record.candidate,sizeof(record.candidate),"%s",certificate); snprintf(record.candidate_id,sizeof(record.candidate_id),"%s",new_id); snprintf(record.command,sizeof(record.command),"%s",id);
  record.pending = 1; record.deadline = deadline; local_deadline = esp_timer_get_time()+60000000LL; save(); return true;
}
bool wg_credentials_tick(bool connected,bool telemetry_acked,bool busy) {
  if (record.pending) {
    if (connected && telemetry_acked) {
      snprintf(record.active,sizeof(record.active),"%s",record.candidate); snprintf(record.active_id,sizeof(record.active_id),"%s",record.candidate_id); record.pending = 0; save(); expires = certificate_expiry(record.active); acknowledge(record.command,"applied"); return true;
    }
    if (esp_timer_get_time() >= local_deadline || time(NULL) >= record.deadline) { record.pending = 0; save(); acknowledge(record.command,"rolled_back"); return true; }
    return false;
  }
  if (!connected || busy || time(NULL) < WG_MINIMUM_EPOCH || !expires || expires-time(NULL) > 21*86400 || !record.active_id[0] || (last_request && esp_timer_get_time()-last_request < 3600000000LL)) return false;
  cJSON *request = cJSON_CreateObject(); cJSON_AddNumberToObject(request,"version",1); cJSON_AddStringToObject(request,"stationId",WG_STATION_ID); cJSON_AddStringToObject(request,"certificateId",record.active_id);
  char *json = cJSON_PrintUnformatted(request); if (json) { send_message("certificate-request",json); free(json); } cJSON_Delete(request); last_request = esp_timer_get_time(); return false;
}
