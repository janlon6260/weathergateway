#include "wg_logs.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "cJSON.h"
#include "provisioning.h"

typedef struct { char message[385], session_id[37]; uint64_t uptime_ms; uint32_t sequence; } log_line_t;
static QueueHandle_t lines;
static vprintf_like_t uart_output;
static char session[37], boot[37], topic[160];
static int64_t lease_end, last_send;
static uint32_t next_sequence, dropped;
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;

// Reentrant ESP-IDF hook: no network, heap allocation, blocking queue or recursive logging here.
static int capture(const char *format, va_list args) {
  va_list copy; va_copy(copy, args);
  int result = uart_output(format, copy); va_end(copy);
  log_line_t line;
  portENTER_CRITICAL(&lock);
  bool active = lease_end > esp_timer_get_time();
  if (active) { memcpy(line.session_id, session, sizeof(session)); line.sequence = next_sequence++; }
  portEXIT_CRITICAL(&lock);
  if (!active) return result;
  va_copy(copy, args); vsnprintf(line.message, sizeof(line.message), format, copy); va_end(copy);
  size_t secret_size = strlen(WG_WIFI_PASSWORD);
  if (secret_size) { char *cursor = line.message, *secret; while ((secret = strstr(cursor, WG_WIFI_PASSWORD))) { memset(secret, '*', secret_size); cursor = secret + secret_size; } }
  line.uptime_ms = esp_timer_get_time() / 1000;
  if (xQueueSend(lines, &line, 0) != pdTRUE) { portENTER_CRITICAL(&lock); dropped++; portEXIT_CRITICAL(&lock); }
  return result;
}
void wg_logs_init(const char *boot_id) {
  snprintf(boot, sizeof(boot), "%s", boot_id);
  snprintf(topic, sizeof(topic), "wg/v1/%s/stations/%s/logs", WG_ENVIRONMENT, WG_STATION_ID);
  lines = xQueueCreate(16, sizeof(log_line_t));
  if (!lines) abort();
  uart_output = vprintf;
  uart_output = esp_log_set_vprintf(capture);
}
void wg_logs_stream(const char *session_id, int64_t until_epoch) {
  int64_t remaining = until_epoch - time(NULL);
  if (remaining < 0) remaining = 0;
  if (remaining > 300) remaining = 300;
  portENTER_CRITICAL(&lock);
  snprintf(session, sizeof(session), "%s", session_id);
  lease_end = remaining ? esp_timer_get_time() + remaining * 1000000LL : 0;
  portEXIT_CRITICAL(&lock);
}
bool wg_logs_active(void) {
  portENTER_CRITICAL(&lock); bool active = lease_end > esp_timer_get_time(); portEXIT_CRITICAL(&lock);
  return active;
}
void wg_logs_tick(esp_mqtt_client_handle_t client, bool connected) {
  const int64_t now = esp_timer_get_time();
  if (!wg_logs_active()) { xQueueReset(lines); return; }
  if (!connected || now - last_send < 200000) return;
  log_line_t line;
  if (xQueueReceive(lines, &line, 0) != pdTRUE) return;
  if (strcmp(line.session_id, session)) return;
  const char *level = line.message[0] == 'E' ? "error" : line.message[0] == 'W' ? "warn" : line.message[0] == 'D' ? "debug" : "info";
  cJSON *o = cJSON_CreateObject();
  cJSON_AddNumberToObject(o, "version", 1); cJSON_AddStringToObject(o, "stationId", WG_STATION_ID);
  cJSON_AddStringToObject(o, "sessionId", line.session_id); cJSON_AddStringToObject(o, "bootId", boot);
  cJSON_AddNumberToObject(o, "sequence", line.sequence); cJSON_AddNumberToObject(o, "uptimeMs", line.uptime_ms);
  portENTER_CRITICAL(&lock); uint32_t losses = dropped; portEXIT_CRITICAL(&lock);
  cJSON_AddNumberToObject(o, "dropped", losses); cJSON_AddStringToObject(o, "level", level);
  cJSON_AddStringToObject(o, "message", line.message);
  char *json = cJSON_PrintUnformatted(o);
  // Best effort diagnostics never occupy the durable observation outbox.
  if (json) { if (esp_mqtt_client_publish(client, topic, json, 0, 0, 0) < 0) { portENTER_CRITICAL(&lock); dropped++; portEXIT_CRITICAL(&lock); } free(json); }
  cJSON_Delete(o); last_send = now;
}
