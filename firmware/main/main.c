#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <sys/time.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_chip_info.h"
#include "esp_secure_boot.h"
#include "esp_efuse.h"
#include "esp_ota_ops.h"
#include "mqtt_client.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "mbedtls/base64.h"
#include "psa/crypto.h"
#include "davis_uart.h"
#include "davis_rfm69.h"
#include "wg_ota.h"
#include "wg_spool.h"
#include "wg_credentials.h"
#include "wg_logs.h"
#include "wg_mqtt_lifecycle.h"
#include "provisioning.h"

#if !CONFIG_MQTT_PROTOCOL_5
#error "MQTT protocol 5 must be enabled in sdkconfig"
#endif

#define COMMAND_SIZE 4096
#define CONFIG_SIZE 1024
static const char *TAG = "weathergateway";
extern const char ca_pem[] asm("_binary_ca_pem_start");
extern const char device_pem[] asm("_binary_device_pem_start");
extern const char device_key[] asm("_binary_device_key_start");
typedef struct {
  uint32_t version;
  char active[CONFIG_SIZE], active_hash[65];
  char previous[CONFIG_SIZE], previous_hash[65];
  char candidate[CONFIG_SIZE], candidate_hash[65], test_id[37];
  char last_command[37], last_status[20];
  uint64_t command_sequence;
  int64_t deadline, last_epoch;
  volatile uint8_t pending;
} persistent_t;
typedef struct { char host[254]; int port, seconds, rx, tx, baud; bool radio; davis_radio_config_t rf; } config_t;
typedef struct { char json[COMMAND_SIZE]; uint8_t kind; } command_t;
static persistent_t state;
static config_t current;
static nvs_handle_t nvs;
static esp_mqtt_client_handle_t mqtt;
static wg_mqtt_lifecycle_t mqtt_lifecycle;
static volatile bool clock_synchronized;
static QueueHandle_t commands;
static EventGroupHandle_t network_events;
static volatile bool connected, new_connection, telemetry_acked;
static volatile int telemetry_message_id = -1;
static char command_topic[160], telemetry_topic[160], ack_topic[160], status_topic[160], firmware_topic[160], receipt_topic[160], mqtt_uri[300], boot_id[37];
static uint32_t observation_sequence;
static int64_t lease_monotonic, last_publish;
static portMUX_TYPE configuration_lock = portMUX_INITIALIZER_UNLOCKED;
static esp_timer_handle_t wifi_retry_timer;
static unsigned wifi_failures;
static int64_t last_spool_send, last_device_status;

static const char *text(cJSON *object, const char *key) { cJSON *v = cJSON_GetObjectItemCaseSensitive(object, key); return cJSON_IsString(v) ? v->valuestring : NULL; }
static bool copy_text(char *target, size_t capacity, const char *source) { if (!source || strlen(source) >= capacity) return false; memcpy(target, source, strlen(source) + 1); return true; }
static bool uuid(const char *v) { if (!v || strlen(v) != 36) return false; for (int i = 0; i < 36; i++) { if (i == 8 || i == 13 || i == 18 || i == 23) { if (v[i] != '-') return false; } else if (!((v[i] >= '0' && v[i] <= '9') || (v[i] >= 'a' && v[i] <= 'f'))) return false; } return true; }
static bool integer(cJSON *object, const char *key, int low, int high, int *out) { cJSON *v = cJSON_GetObjectItemCaseSensitive(object, key); if (!cJSON_IsNumber(v) || !isfinite(v->valuedouble) || v->valuedouble != floor(v->valuedouble) || v->valuedouble < low || v->valuedouble > high) return false; *out = (int)v->valuedouble; return true; }
static bool pin(int value) { const int valid[] = {16,17,18,19,21,22,23,25,26,27,32,33}; for (int i = 0; i < sizeof(valid)/sizeof(valid[0]); i++) if (value == valid[i]) return true; return false; }
static bool radio_pin(int value) { return value == 13 || value == 14 || pin(value); }
static bool digest_matches(const char *json, const char *expected) {
  unsigned char hash[32]; char hex[65]; size_t length = 0;
  if (!expected || strlen(expected) != 64 || psa_hash_compute(PSA_ALG_SHA_256, (const unsigned char *)json, strlen(json), hash, sizeof(hash), &length) != PSA_SUCCESS || length != sizeof(hash)) return false;
  for (int i = 0; i < 32; ++i) snprintf(hex + i * 2, 3, "%02x", hash[i]);
  return strcmp(hex, expected) == 0;
}
static bool parse_config(const char *json, config_t *out) {
  memset(out, 0, sizeof(*out));
  cJSON *o = cJSON_Parse(json); if (!cJSON_IsObject(o)) { cJSON_Delete(o); return false; }
  const char *interface = text(o, "interface");
  out->radio = interface && !strcmp(interface, "davis-iss-rfm69");
  if (cJSON_GetArraySize(o) != (out->radio ? 13 : 7)) { cJSON_Delete(o); return false; }
  const char *station = text(o, "stationId"), *host = text(o, "mqttHost"), *baud = text(o, "uartBaud");
  bool valid = station && !strcmp(station, WG_STATION_ID) && copy_text(out->host, sizeof(out->host), host) &&
    integer(o, "mqttPort", 1, 65535, &out->port) && integer(o, "sampleSeconds", 1, 300, &out->seconds);
  if (valid && out->radio) {
    const char *band = text(o, "radioBand");
    valid = band && !strcmp(band, "EU868") && integer(o, "transmitterId", 1, 8, &out->rf.transmitter_id) &&
      integer(o, "spiSck", 0, 33, &out->rf.sck) && integer(o, "spiMiso", 0, 33, &out->rf.miso) &&
      integer(o, "spiMosi", 0, 33, &out->rf.mosi) && integer(o, "radioCs", 0, 33, &out->rf.cs) &&
      integer(o, "radioReset", 0, 33, &out->rf.reset) && integer(o, "radioDio0", 0, 33, &out->rf.dio0);
    int values[] = {out->rf.sck, out->rf.miso, out->rf.mosi, out->rf.cs, out->rf.reset, out->rf.dio0};
    for (int i = 0; valid && i < 6; i++) {
      if (!radio_pin(values[i])) valid = false;
      for (int j = 0; j < i; j++) if (values[i] == values[j]) valid = false;
    }
  } else if (valid) {
    valid = baud && integer(o, "uartRx", 0, 39, &out->rx) && integer(o, "uartTx", 0, 39, &out->tx);
    if (valid) { out->baud = atoi(baud); valid = pin(out->rx) && pin(out->tx) && out->rx != out->tx && (!strcmp(baud,"19200") || !strcmp(baud,"9600") || !strcmp(baud,"2400") || !strcmp(baud,"1200")); }
  }
  if (valid) valid = host[0] && !strstr(host, "..");
  if (valid) for (const char *p = host; *p; ++p) if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '.' || *p == '-')) valid = false;
  cJSON_Delete(o); return valid;
}
static void persist(void) { ESP_ERROR_CHECK(nvs_set_blob(nvs, "state", &state, sizeof(state))); ESP_ERROR_CHECK(nvs_commit(nvs)); }
static const char *configuration_json(void) { return state.pending ? state.candidate : state.active; }
static const char *configuration_hash(void) { return state.pending ? state.candidate_hash : state.active_hash; }
static void ack(const char *id, const char *status) {
  if (!connected || !uuid(id)) return;
  cJSON *o = cJSON_CreateObject(); cJSON_AddNumberToObject(o, "version", 1); cJSON_AddStringToObject(o, "stationId", WG_STATION_ID); cJSON_AddStringToObject(o, "commandId", id); cJSON_AddStringToObject(o, "status", status); cJSON_AddStringToObject(o, "configurationHash", configuration_hash());
  const char *release = wg_ota_ack_release(id); if (release && release[0]) cJSON_AddStringToObject(o, "firmwareReleaseId", release);
  if (wg_credentials_id()[0]) cJSON_AddStringToObject(o,"certificateId",wg_credentials_id());
  if (!strcmp(id, state.last_command) && strcmp(status,state.last_status)) { copy_text(state.last_status,sizeof(state.last_status),status); persist(); }
  char *json = cJSON_PrintUnformatted(o); if (json) { esp_mqtt_client_publish(mqtt, ack_topic, json, 0, 1, 0); free(json); } cJSON_Delete(o);
}
static void mqtt_event(void *arg, esp_event_base_t base, int32_t event_id, void *data) {
  esp_mqtt_event_handle_t event = data;
  static command_t incoming;
  static bool accepting;
  switch (event_id) {
    case MQTT_EVENT_CONNECTED: connected = true; new_connection = true; ESP_LOGI(TAG, "MQTT connected with TLS and device certificate"); esp_mqtt_client_subscribe(event->client, command_topic, 1); esp_mqtt_client_subscribe(event->client, firmware_topic, 1); esp_mqtt_client_subscribe(event->client, receipt_topic, 1); break;
    case MQTT_EVENT_DISCONNECTED: connected = false; ESP_LOGW(TAG, "MQTT disconnected; observations remain in durable storage"); break;
    case MQTT_EVENT_ERROR:
      if (event->error_handle) {
        const esp_mqtt_error_codes_t *error = event->error_handle;
        if (error->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT)
          ESP_LOGE(TAG, "MQTT/TLS failed for %s:%d: sdk=%s tls=0x%x verify=0x%x socket_errno=%d", current.host, current.port, esp_err_to_name(error->esp_tls_last_esp_err), (unsigned)error->esp_tls_stack_err, (unsigned)error->esp_tls_cert_verify_flags, error->esp_transport_sock_errno);
        else ESP_LOGE(TAG, "MQTT broker refused connection: type=%d return_code=%d", (int)error->error_type, (int)error->connect_return_code);
      }
      break;
    case MQTT_EVENT_PUBLISHED: if (event->msg_id == telemetry_message_id) telemetry_acked = true; break;
    case MQTT_EVENT_DATA:
      if (event->current_data_offset == 0) {
        incoming.kind = event->topic_len == strlen(firmware_topic) && !memcmp(event->topic, firmware_topic, event->topic_len) ? 1 : event->topic_len == strlen(receipt_topic) && !memcmp(event->topic,receipt_topic,event->topic_len) ? 2 : 0;
        accepting = (incoming.kind || (event->topic_len == strlen(command_topic) && !memcmp(event->topic, command_topic, event->topic_len))) && event->total_data_len > 0 && event->total_data_len < COMMAND_SIZE;
      }
      if (!accepting || event->current_data_offset < 0 || event->data_len < 0 || event->current_data_offset + event->data_len >= COMMAND_SIZE) break;
      memcpy(incoming.json + event->current_data_offset, event->data, event->data_len);
      if (event->current_data_offset + event->data_len == event->total_data_len) { incoming.json[event->total_data_len] = 0; xQueueSend(commands, &incoming, 0); accepting = false; }
      break;
    default: break;
  }
}
static void reconnect(void) {
  wg_mqtt_lifecycle_stop(&mqtt_lifecycle);
  if (mqtt) { esp_mqtt_client_destroy(mqtt); mqtt = NULL; }
  connected = false; new_connection = false;
  telemetry_acked = false; telemetry_message_id = -1;
  if (!parse_config(configuration_json(), &current)) abort();
  davis_stop(); davis_radio_stop();
  if (current.radio) (void)davis_radio_init(&current.rf);
  else davis_init(current.rx, current.tx, current.baud);
  snprintf(mqtt_uri, sizeof(mqtt_uri), "mqtts://%s:%d", current.host, current.port);
  esp_mqtt_client_config_t config = {
    .broker.address.uri = mqtt_uri,
    .broker.verification.certificate = ca_pem,
    .credentials.authentication.certificate = wg_credentials_certificate(),
    .credentials.authentication.key = device_key,
    .session.protocol_ver = MQTT_PROTOCOL_V_5,
    .network.reconnect_timeout_ms = 2000,
    .network.timeout_ms = 8000,
    .buffer.size = 2048, .buffer.out_size = 2048,
    .outbox.limit = 8192,
    .session.last_will.topic = status_topic,
    .session.last_will.msg = "{\"online\":false}",
    .session.last_will.qos = 1,
    .session.last_will.retain = 1,
  };
  mqtt = esp_mqtt_client_init(&config); if (!mqtt) abort();
  mqtt_lifecycle = (wg_mqtt_lifecycle_t){.client = mqtt};
  ESP_ERROR_CHECK(esp_mqtt_client_register_event(mqtt, ESP_EVENT_ANY_ID, mqtt_event, NULL));
  ESP_LOGI(TAG, "MQTT configured: %s:%d; TLS peer verification enabled", current.host, current.port);
}
static int64_t expiry(const char *value) {
  if (!value || strlen(value) != 24 || value[23] != 'Z') return 0;
  struct tm parsed = {0}; int y, mo, d, h, mi, s;
  if (sscanf(value, "%d-%d-%dT%d:%d:%d", &y, &mo, &d, &h, &mi, &s) != 6) return 0;
  parsed.tm_year = y - 1900; parsed.tm_mon = mo - 1; parsed.tm_mday = d; parsed.tm_hour = h; parsed.tm_min = mi; parsed.tm_sec = s;
  return (int64_t)mktime(&parsed);
}
static void rollback(void) {
  if (state.pending) { state.pending = 0; state.candidate[0] = 0; copy_text(state.last_status, sizeof(state.last_status), "rolled_back"); persist(); reconnect(); }
}
static void process_command(const char *json) {
  cJSON *o = cJSON_Parse(json); if (!o) return;
  const char *target = text(o, "stationId"), *id = text(o, "commandId"), *kind = text(o, "kind"), *digest = text(o, "configurationHash");
  cJSON *sequence = cJSON_GetObjectItemCaseSensitive(o, "sequence"), *version = cJSON_GetObjectItemCaseSensitive(o, "version");
  int64_t now = time(NULL), end = expiry(text(o, "expiresAt"));
  if (!target || strcmp(target, WG_STATION_ID) || !uuid(id) || !kind || !cJSON_IsNumber(version) || version->valueint != 1 || !cJSON_IsNumber(sequence) || sequence->valuedouble < 1 || sequence->valuedouble > 9007199254740991.0 || floor(sequence->valuedouble) != sequence->valuedouble || now < WG_MINIMUM_EPOCH || now < state.last_epoch || end <= now || end - now > 3600) goto done;
  uint64_t seq = (uint64_t)sequence->valuedouble;
  if (seq <= state.command_sequence) { if (!strcmp(id, state.last_command)) ack(id, state.last_status); goto done; }
  if (!strcmp(kind, "test_config")) {
    if (state.pending || wg_ota_busy() || wg_credentials_pending() || !digest || strlen(digest) != 64) { ack(id, "rejected"); goto done; }
    cJSON *candidate = cJSON_GetObjectItemCaseSensitive(o, "configuration"); char *encoded = cJSON_PrintUnformatted(candidate); config_t proposed;
    if (!encoded || strlen(encoded) >= CONFIG_SIZE || !parse_config(encoded, &proposed) || !digest_matches(encoded, digest)) { free(encoded); ack(id, "rejected"); goto done; }
    copy_text(state.candidate, sizeof(state.candidate), encoded); free(encoded);
    copy_text(state.candidate_hash, sizeof(state.candidate_hash), digest); copy_text(state.test_id, sizeof(state.test_id), id);
    const int64_t lease = esp_timer_get_time() + (end - now) * 1000000LL;
    portENTER_CRITICAL(&configuration_lock);
    state.deadline = end; lease_monotonic = lease; state.last_epoch = now; state.pending = 1;
    portEXIT_CRITICAL(&configuration_lock);
    copy_text(state.last_status, sizeof(state.last_status), "testing");
  } else if (!strcmp(kind, "commit_config")) {
    if (!state.pending || !digest || strcmp(digest, state.candidate_hash)) { ack(id, "rejected"); goto done; }
    copy_text(state.previous, sizeof(state.previous), state.active); copy_text(state.previous_hash, sizeof(state.previous_hash), state.active_hash);
    copy_text(state.active, sizeof(state.active), state.candidate); copy_text(state.active_hash, sizeof(state.active_hash), state.candidate_hash);
    state.pending = 0; copy_text(state.last_status, sizeof(state.last_status), "applied");
  } else if (!strcmp(kind, "rollback_config")) {
    if (state.pending && digest && !strcmp(digest, state.candidate_hash)) state.pending = 0;
    else if (digest && !strcmp(digest, state.active_hash) && state.previous[0]) { copy_text(state.active, sizeof(state.active), state.previous); copy_text(state.active_hash, sizeof(state.active_hash), state.previous_hash); }
    else { ack(id, "rejected"); goto done; }
    copy_text(state.last_status, sizeof(state.last_status), "rolled_back");
  } else if (!strcmp(kind,"test_firmware") || !strcmp(kind,"commit_firmware") || !strcmp(kind,"rollback_firmware")) {
    state.command_sequence = seq; state.last_epoch = now; copy_text(state.last_command,sizeof(state.last_command),id); copy_text(state.last_status,sizeof(state.last_status),"received"); persist();
    wg_ota_command(o,id,end,state.pending || wg_credentials_pending()); goto done;
  } else if (!strcmp(kind,"renew_certificate")) {
    state.command_sequence = seq; state.last_epoch = now; copy_text(state.last_command,sizeof(state.last_command),id); copy_text(state.last_status,sizeof(state.last_status),"received"); persist();
    if (wg_credentials_stage(o,id,end,state.pending || wg_ota_busy())) { ack(id,"received"); reconnect(); } else ack(id,"rejected"); goto done;
  } else if (!strcmp(kind, "stream_logs")) {
    const char *session_id = text(o, "logSessionId"); int64_t log_end = expiry(text(o, "logExpiresAt"));
    if (!uuid(session_id) || !log_end || log_end - now > 300) { ack(id, "rejected"); goto done; }
    wg_logs_stream(session_id, log_end);
    copy_text(state.last_status, sizeof(state.last_status), "applied");
    ESP_LOGI(TAG, "Network logging %s; bounded RAM queue and automatic expiry", wg_logs_active() ? "started" : "stopped");
  } else if (!strcmp(kind, "restart")) { ESP_LOGW(TAG, "Restart requested by administrator"); copy_text(state.last_status, sizeof(state.last_status), "applied"); }
  else { ack(id, "rejected"); goto done; }
  state.command_sequence = seq; state.last_epoch = now; copy_text(state.last_command, sizeof(state.last_command), id); persist();
  ack(id, state.last_status);
  if (!strcmp(kind, "restart")) { cJSON_Delete(o); vTaskDelay(pdMS_TO_TICKS(500)); esp_restart(); }
  else if (!strcmp(kind, "test_config") || !strcmp(kind, "rollback_config")) reconnect();
done:
  cJSON_Delete(o);
}
static void wifi_retry(void *arg) { (void)arg; esp_wifi_connect(); }
static void clock_ready(struct timeval *now) {
  clock_synchronized = now->tv_sec >= WG_MINIMUM_EPOCH;
  if (clock_synchronized) ESP_LOGI(TAG, "NTP time synchronized; TLS certificate verification can proceed");
  else ESP_LOGW(TAG, "NTP supplied an implausible date; MQTT/TLS remains stopped");
}
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
  else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    wifi_event_sta_disconnected_t *event = data;
    ESP_LOGW(TAG, "Wi-Fi disconnected: reason=%u; reconnecting with backoff", event ? (unsigned)event->reason : 0);
    connected = false; xEventGroupClearBits(network_events, 1); if (wifi_failures < 5) wifi_failures++;
    (void)esp_timer_stop(wifi_retry_timer); ESP_ERROR_CHECK(esp_timer_start_once(wifi_retry_timer, (1LL << wifi_failures) * 1000000LL));
  }
  else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *event = data;
    if (event) ESP_LOGI(TAG, "Wi-Fi ready: IP=" IPSTR " gateway=" IPSTR, IP2STR(&event->ip_info.ip), IP2STR(&event->ip_info.gw));
    esp_netif_dns_info_t dns;
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif && esp_netif_get_dns_info(netif, ESP_NETIF_DNS_MAIN, &dns) == ESP_OK && dns.ip.type == ESP_IPADDR_TYPE_V4)
      ESP_LOGI(TAG, "DHCP DNS=" IPSTR, IP2STR(&dns.ip.u_addr.ip4));
    (void)esp_timer_stop(wifi_retry_timer); wifi_failures = 0; xEventGroupSetBits(network_events, 1);
    ESP_ERROR_CHECK(esp_netif_sntp_start());
  }
  else if (base == IP_EVENT && id == IP_EVENT_STA_LOST_IP) {
    connected = false; xEventGroupClearBits(network_events, 1);
    ESP_LOGW(TAG, "DHCP IP address lost; MQTT paused until an address is restored");
  }
}
static void emit_record(const wg_spool_record_t *record) {
  if (!connected) return;
  int64_t epoch_ms = record->epoch_ms; bool mapped = false, undated = false;
  if (!epoch_ms && !strcmp(record->boot_id,boot_id)) {
    if (time(NULL) < WG_MINIMUM_EPOCH) return;
    struct timeval tv; gettimeofday(&tv,NULL);
    epoch_ms = (int64_t)tv.tv_sec*1000+tv.tv_usec/1000-(esp_timer_get_time()-record->monotonic_us)/1000LL; mapped = true;
  } else if (!epoch_ms) undated = true;
  cJSON *o = cJSON_CreateObject(); cJSON_AddNumberToObject(o,"version",1); cJSON_AddStringToObject(o,"stationId",WG_STATION_ID); cJSON_AddStringToObject(o,"bootId",record->boot_id); cJSON_AddNumberToObject(o,"sequence",record->sequence); cJSON_AddStringToObject(o,"firmware","wg-esp32-2.1.1"); cJSON_AddBoolToObject(o,"sensorContact",record->packet_size > 0); cJSON_AddObjectToObject(o,"measurements"); cJSON_AddStringToObject(o,"configurationHash",record->configuration_hash);
  if (record->release_id[0]) cJSON_AddStringToObject(o,"firmwareReleaseId",record->release_id);
  if (wg_credentials_id()[0]) cJSON_AddStringToObject(o,"certificateId",wg_credentials_id());
  if (undated) { cJSON_AddNumberToObject(o,"monotonicUs",record->monotonic_us); cJSON_AddStringToObject(o,"reason","clock-unavailable-before-reboot"); }
  else { time_t epoch = epoch_ms/1000; struct tm utc; char stamp[32], prefix[24]; gmtime_r(&epoch,&utc); strftime(prefix,sizeof(prefix),"%Y-%m-%dT%H:%M:%S",&utc); snprintf(stamp,sizeof(stamp),"%s.%03dZ",prefix,(int)(epoch_ms%1000)); cJSON_AddStringToObject(o,"observedAt",stamp); cJSON_AddStringToObject(o,"timeQuality",mapped ? "mappedWithinBoot" : "ntp"); }
  if (record->packet_size) {
    unsigned char encoded[133]; size_t length;
    if (!mbedtls_base64_encode(encoded,sizeof(encoded),&length,record->packet,record->packet_size)) {
      encoded[length] = 0; cJSON *source = cJSON_AddObjectToObject(o,"source"); cJSON_AddStringToObject(source,"protocol",record->packet_size == 10 ? "davis-iss" : "davis-loop"); cJSON_AddStringToObject(source,"packet",(char *)encoded);
      if (record->packet_size == 10) { cJSON_AddNumberToObject(source,"channel",record->channel); cJSON_AddNumberToObject(source,"rssiDbm",record->rssi); }
    }
  }
  char topic[180]; snprintf(topic,sizeof(topic),"wg/v1/%s/stations/%s/%s",WG_ENVIRONMENT,WG_STATION_ID,undated ? "telemetry-undated" : "telemetry");
  char *json = cJSON_PrintUnformatted(o); if (json) { telemetry_message_id = esp_mqtt_client_publish(mqtt,topic,json,0,1,0); free(json); } cJSON_Delete(o);
}
static void publish(const uint8_t *packet, size_t packet_size, int channel, int rssi_dbm) {
  struct timeval tv; gettimeofday(&tv,NULL);
  wg_spool_record_t record = {0}; record.epoch_ms = tv.tv_sec >= WG_MINIMUM_EPOCH ? (int64_t)tv.tv_sec*1000+tv.tv_usec/1000 : 0; record.monotonic_us = esp_timer_get_time(); record.sequence = observation_sequence++;
  copy_text(record.boot_id,sizeof(record.boot_id),boot_id); copy_text(record.configuration_hash,sizeof(record.configuration_hash),configuration_hash()); copy_text(record.release_id,sizeof(record.release_id),wg_ota_release());
  record.packet_size = packet_size; record.channel = channel; record.rssi = rssi_dbm; if (packet) memcpy(record.packet,packet,packet_size);
  if (wg_spool_append(&record)) emit_record(&record);
  last_publish = esp_timer_get_time();
}
static void receipt(cJSON *o) {
  const char *station = text(o,"stationId"), *boot = text(o,"bootId"), *status = text(o,"status"); cJSON *sequence = cJSON_GetObjectItemCaseSensitive(o,"sequence");
  if (!station || strcmp(station,WG_STATION_ID) || !boot || !status || (strcmp(status,"stored") && strcmp(status,"rejected")) || !cJSON_IsNumber(sequence)) return;
  wg_spool_record_t record; if (wg_spool_peek(&record) && !strcmp(boot,record.boot_id) && sequence->valuedouble == record.sequence) { wg_spool_ack(record.number); last_spool_send = 0; }
}
static void ota_send(const char *suffix, const char *json) { char topic[180]; snprintf(topic,sizeof(topic),"wg/v1/%s/stations/%s/%s",WG_ENVIRONMENT,WG_STATION_ID,suffix); if (connected) esp_mqtt_client_publish(mqtt,topic,json,0,1,0); }
static void configuration_watchdog(void *unused) {
  (void)unused;
  for (;;) {
    // A stalled network task cannot extend a configuration trial. Restarting
    // restores the confirmed NVS record before any connection is attempted.
    const int64_t monotonic_now = esp_timer_get_time(), wall_now = time(NULL);
    portENTER_CRITICAL(&configuration_lock);
    const bool expired = state.pending && lease_monotonic > 0 && (monotonic_now >= lease_monotonic || wall_now >= state.deadline);
    portEXIT_CRITICAL(&configuration_lock);
    if (expired) esp_restart();
    vTaskDelay(pdMS_TO_TICKS(200));
  }
}
void app_main(void) {
  esp_log_level_set("*", ESP_LOG_WARN); esp_log_level_set(TAG, ESP_LOG_INFO); esp_log_level_set("davis_radio", ESP_LOG_INFO);
  setenv("TZ", "UTC0", 1); tzset();
  if (psa_crypto_init() != PSA_SUCCESS) abort();
  ESP_ERROR_CHECK(nvs_flash_init()); ESP_ERROR_CHECK(nvs_open("gateway", NVS_READWRITE, &nvs));
  size_t length = sizeof(state); esp_err_t loaded = nvs_get_blob(nvs, "state", &state, &length);
  if (loaded == ESP_ERR_NVS_NOT_FOUND) { memset(&state, 0, sizeof(state)); state.version = 1; copy_text(state.active, sizeof(state.active), WG_DEFAULT_CONFIG); copy_text(state.active_hash, sizeof(state.active_hash), WG_DEFAULT_HASH); persist(); }
  else if (loaded != ESP_OK || length != sizeof(state) || state.version != 1) abort();
  // A power cycle never grants a new test lease. Restore the confirmed record.
  if (state.pending) { state.pending = 0; copy_text(state.last_status, sizeof(state.last_status), "rolled_back"); persist(); }
  wg_ota_init(nvs,ota_send,ack);
  wg_credentials_init(nvs,ota_send,ack);
  wg_spool_init(nvs);
  if (xTaskCreate(configuration_watchdog,"config-watchdog",2048,NULL,5,NULL) != pdPASS) abort();
  commands = xQueueCreate(2, sizeof(command_t)); network_events = xEventGroupCreate(); if (!commands || !network_events) abort();
  esp_timer_create_args_t retry_args = { .callback = wifi_retry, .name = "wifi-retry" }; ESP_ERROR_CHECK(esp_timer_create(&retry_args, &wifi_retry_timer));
  ESP_ERROR_CHECK(esp_netif_init()); ESP_ERROR_CHECK(esp_event_loop_create_default()); esp_netif_create_default_wifi_sta();
  wifi_init_config_t wifi = WIFI_INIT_CONFIG_DEFAULT(); ESP_ERROR_CHECK(esp_wifi_init(&wifi));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL)); ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
  wifi_config_t credentials = {0};
  if (strlen(WG_WIFI_SSID) > sizeof(credentials.sta.ssid) || strlen(WG_WIFI_PASSWORD) >= sizeof(credentials.sta.password)) abort();
  memcpy(credentials.sta.ssid, WG_WIFI_SSID, strlen(WG_WIFI_SSID));
  memcpy(credentials.sta.password, WG_WIFI_PASSWORD, strlen(WG_WIFI_PASSWORD));
  credentials.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA)); ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &credentials));
  esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org"); sntp.start = false; sntp.sync_cb = clock_ready;
  ESP_ERROR_CHECK(esp_netif_sntp_init(&sntp));
  ESP_ERROR_CHECK(esp_wifi_start());
  uint8_t random[16]; esp_fill_random(random, sizeof(random)); random[6] = (random[6] & 15) | 64; random[8] = (random[8] & 63) | 128;
  snprintf(boot_id, sizeof(boot_id), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", random[0],random[1],random[2],random[3],random[4],random[5],random[6],random[7],random[8],random[9],random[10],random[11],random[12],random[13],random[14],random[15]);
  wg_logs_init(boot_id);
  ESP_LOGI(TAG, "WeatherGateway 2.1.1 started; station %s", WG_STATION_ID);
  snprintf(command_topic, sizeof(command_topic), "wg/v1/%s/stations/%s/commands", WG_ENVIRONMENT, WG_STATION_ID); snprintf(telemetry_topic, sizeof(telemetry_topic), "wg/v1/%s/stations/%s/telemetry", WG_ENVIRONMENT, WG_STATION_ID); snprintf(ack_topic, sizeof(ack_topic), "wg/v1/%s/stations/%s/acks", WG_ENVIRONMENT, WG_STATION_ID); snprintf(status_topic, sizeof(status_topic), "wg/v1/%s/stations/%s/status", WG_ENVIRONMENT, WG_STATION_ID);
  snprintf(firmware_topic,sizeof(firmware_topic),"wg/v1/%s/stations/%s/firmware-data",WG_ENVIRONMENT,WG_STATION_ID);
  snprintf(receipt_topic,sizeof(receipt_topic),"wg/v1/%s/stations/%s/telemetry-receipt",WG_ENVIRONMENT,WG_STATION_ID);
  reconnect();
  esp_ota_img_states_t ota_state; const esp_partition_t *running = esp_ota_get_running_partition(); bool verifying = !wg_ota_busy() && esp_ota_get_state_partition(running, &ota_state) == ESP_OK && ota_state == ESP_OTA_IMG_PENDING_VERIFY;
  int64_t verify_deadline = esp_timer_get_time() + 120000000LL;
  command_t command; uint8_t packet[99];
  while (true) {
    int64_t now = esp_timer_get_time();
    wg_mqtt_lifecycle_tick(&mqtt_lifecycle, (xEventGroupGetBits(network_events) & 1) != 0, clock_synchronized && time(NULL) >= WG_MINIMUM_EPOCH, now);
    if (state.pending && (time(NULL) >= state.deadline || time(NULL) < state.last_epoch || now >= lease_monotonic)) rollback();
    bool reconnected = new_connection; new_connection = false;
    if (reconnected && state.last_command[0]) ack(state.last_command, state.last_status);
    if (xQueueReceive(commands, &command, 0) == pdTRUE) { if (command.kind) { cJSON *o = cJSON_Parse(command.json); if (o) { if (command.kind == 1) wg_ota_data(o); else receipt(o); cJSON_Delete(o); } } else process_command(command.json); }
    bool got_packet; int channel = 0, rssi = 0;
    if (current.radio) got_packet = davis_radio_poll(now / 1000, packet, &channel, &rssi);
    else got_packet = davis_poll(now / 1000, current.seconds, packet);
    bool failed = current.radio ? davis_radio_failed(now / 1000) : davis_failed();
    if (got_packet) {
      publish(packet, current.radio ? 10 : 99, channel, rssi);
      static int64_t last_packet_log;
      if (now-last_packet_log >= 10000000LL) { ESP_LOGI(TAG, "Sensor packet received: channel=%d, RSSI=%d dBm", channel+1, rssi); last_packet_log=now; }
    }
    else if (failed && now - last_publish >= current.seconds * 1000000LL) publish(NULL, 0, 0, 0);
    if (verifying && telemetry_acked && !failed) { ESP_ERROR_CHECK(esp_ota_mark_app_valid_cancel_rollback()); verifying = false; }
    if (verifying && now >= verify_deadline) esp_ota_mark_app_invalid_rollback_and_reboot();
    wg_ota_tick(connected,got_packet,telemetry_acked,reconnected);
    wg_logs_tick(mqtt, connected);
    if (wg_credentials_tick(connected,telemetry_acked,state.pending || wg_ota_busy())) reconnect();
    if (connected && now-last_spool_send >= 3000000LL) { wg_spool_record_t queued; if (wg_spool_peek(&queued)) { emit_record(&queued); last_spool_send = now; } }
    if (connected && (reconnected || now-last_device_status >= 30000000LL)) {
      cJSON *o = cJSON_CreateObject(); cJSON_AddBoolToObject(o,"online",true); cJSON_AddNumberToObject(o,"pending",wg_spool_pending()); cJSON_AddNumberToObject(o,"capacity",wg_spool_capacity()); cJSON_AddNumberToObject(o,"dropped",wg_spool_dropped()); cJSON_AddBoolToObject(o,"clockSynchronized",time(NULL) >= WG_MINIMUM_EPOCH);
      esp_chip_info_t chip; esp_chip_info(&chip);
      ESP_LOGI(TAG, "Status: sensor=%s pending=%u dropped=%u heap=%u", failed ? "missing" : "OK", (unsigned)wg_spool_pending(), (unsigned)wg_spool_dropped(), (unsigned)esp_get_free_heap_size());
      esp_netif_ip_info_t network; esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
      if (netif && esp_netif_get_ip_info(netif, &network) == ESP_OK) { char ip[16]; snprintf(ip, sizeof(ip), IPSTR, IP2STR(&network.ip)); cJSON_AddStringToObject(o, "ipAddress", ip); }
      wifi_ap_record_t access_point; if (esp_wifi_sta_get_ap_info(&access_point) == ESP_OK) cJSON_AddNumberToObject(o, "wifiRssiDbm", access_point.rssi);
      cJSON_AddBoolToObject(o, "logStreaming", wg_logs_active());
      cJSON *security = cJSON_AddObjectToObject(o,"security"); cJSON_AddNumberToObject(security,"chipRevision",chip.revision); cJSON_AddBoolToObject(security,"secureBoot",esp_secure_boot_enabled()); cJSON_AddBoolToObject(security,"flashEncryption",esp_efuse_is_flash_encryption_enabled());
#if CONFIG_NVS_ENCRYPTION
      cJSON_AddBoolToObject(security,"nvsEncryption",true);
#else
      cJSON_AddBoolToObject(security,"nvsEncryption",false);
#endif
      char *json = cJSON_PrintUnformatted(o); if (json) { esp_mqtt_client_publish(mqtt,status_topic,json,0,1,1); free(json); } cJSON_Delete(o); last_device_status = now;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}
