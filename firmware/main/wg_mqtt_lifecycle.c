#include "wg_mqtt_lifecycle.h"
#include "esp_log.h"
static const char *TAG = "weathergateway";

void wg_mqtt_lifecycle_stop(wg_mqtt_lifecycle_t *state) {
  if (state->client && state->started) {
    esp_err_t error = esp_mqtt_client_stop(state->client);
    if (error != ESP_OK) ESP_LOGW(TAG, "MQTT stop: %s", esp_err_to_name(error));
  }
  state->started = false;
}
void wg_mqtt_lifecycle_tick(wg_mqtt_lifecycle_t *state, bool network_up, bool clock_ready, int64_t now_us) {
  if (!state->client) return;
  if (!network_up || !clock_ready) {
    wg_mqtt_lifecycle_stop(state);
    const int waiting = network_up ? 2 : 1;
    if (state->waiting != waiting || now_us - state->last_wait_log >= 30000000LL) {
      ESP_LOGI(TAG, "%s", network_up ? "Waiting for NTP time before MQTT/TLS certificate verification; allow DNS and UDP/123" : "Waiting for Wi-Fi/DHCP before MQTT/DNS");
      state->last_wait_log = now_us;
    }
    state->waiting = waiting;
    return;
  }
  state->waiting = 0;
  if (state->started || now_us < state->retry_at) return;
  esp_err_t error = esp_mqtt_client_start(state->client);
  if (error == ESP_OK) { state->started = true; state->retry_at = 0; }
  else { state->retry_at = now_us + 5000000LL; ESP_LOGE(TAG, "MQTT start failed: %s; retrying in 5 seconds", esp_err_to_name(error)); }
}
