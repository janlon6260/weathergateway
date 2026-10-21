#include "wg_radio_receiver.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"

static SemaphoreHandle_t driver_lock;
static QueueHandle_t frames;
static bool running;
static davis_radio_config_t active;
static char active_hash[65];
static uint64_t queue_dropped;

// A bounded 40-second queue at ISS ID 1. No MQTT, JSON or flash writes run here.
// In particular esp-mqtt's API mutex may be held during TLS/network operations;
// even enqueue() therefore belongs in the consuming task, never this one.
static void receiver_step(void) {
  xSemaphoreTake(driver_lock, portMAX_DELAY);
  if (running) {
    wg_radio_frame_t frame = {.monotonic_us = esp_timer_get_time()};
    if (davis_radio_poll(frame.monotonic_us / 1000, frame.packet, &frame.channel, &frame.rssi_dbm) &&
        xQueueSend(frames, &frame, 0) != pdTRUE) queue_dropped++;
  }
  xSemaphoreGive(driver_lock);
}
static void receiver_task(void *unused) {
  (void)unused;
  for (;;) { receiver_step(); vTaskDelay(pdMS_TO_TICKS(5)); }
}
void wg_radio_receiver_start(const davis_radio_config_t *config, const char *configuration_hash) {
  if (!driver_lock) {
    driver_lock = xSemaphoreCreateMutex(); frames = xQueueCreate(16, sizeof(wg_radio_frame_t));
    if (!driver_lock || !frames || xTaskCreate(receiver_task, "iss-radio", 4096, NULL, 6, NULL) != pdPASS) abort();
  }
  xSemaphoreTake(driver_lock, portMAX_DELAY);
  if (!running || memcmp(&active, config, sizeof(active))) {
    active = *config; xQueueReset(frames);
    (void)davis_radio_init(&active); running = true;
  } else if (strcmp(active_hash, configuration_hash)) xQueueReset(frames);
  snprintf(active_hash, sizeof(active_hash), "%s", configuration_hash);
  xSemaphoreGive(driver_lock);
}
void wg_radio_receiver_stop(void) {
  if (!driver_lock) return;
  xSemaphoreTake(driver_lock, portMAX_DELAY);
  running = false; davis_radio_stop(); xQueueReset(frames);
  xSemaphoreGive(driver_lock);
}
bool wg_radio_receiver_read(wg_radio_frame_t *frame) {
  return frames && xQueueReceive(frames, frame, 0) == pdTRUE;
}
bool wg_radio_receiver_failed(void) {
  if (!driver_lock) return true;
  xSemaphoreTake(driver_lock, portMAX_DELAY);
  bool failed = !running || davis_radio_failed(esp_timer_get_time() / 1000);
  xSemaphoreGive(driver_lock); return failed;
}
void wg_radio_receiver_health(cJSON *object) {
  if (!driver_lock) return;
  xSemaphoreTake(driver_lock, portMAX_DELAY);
  davis_radio_stats_t status; davis_radio_stats(&status);
  bool enabled = running; uint64_t dropped = queue_dropped;
  unsigned queued = uxQueueMessagesWaiting(frames);
  xSemaphoreGive(driver_lock);
  if (!enabled) return;
  const char *reason = status.last_bad_reason == 1 ? "crc" : status.last_bad_reason == 2 ? "repeater" : "transmitter-id";
  ESP_LOGI("davis_radio", "RX: ISS=%d listen=%d state=%s packets=%llu missed=%llu crc=%llu fifo=%llu spi=%llu resync=%llu queue=%u dropped=%llu pollMax=%llu ms",
    status.transmitter_id, status.channel + 1, !status.ready ? "unavailable" : status.locked ? "tracking" : "scanning",
    (unsigned long long)status.packets, (unsigned long long)status.missed_packets, (unsigned long long)status.crc_errors,
    (unsigned long long)status.fifo_overruns, (unsigned long long)status.spi_errors, (unsigned long long)status.resyncs,
    queued, (unsigned long long)dropped, (unsigned long long)((status.max_poll_gap_us + 999) / 1000));
  ESP_LOGI("davis_radio", "RF: trigger=%d dBm background=%d dBm sampled=%d signalTimeouts=%llu pllTimeouts=%llu foreign=%llu repeater=%llu AFC=%d Hz",
    status.rssi_threshold_dbm, status.background_rssi_dbm, status.background_sampled,
    (unsigned long long)status.receiver_timeouts, (unsigned long long)status.pll_timeouts,
    (unsigned long long)status.foreign_packets, (unsigned long long)status.repeater_packets, status.last_afc_hz);
  if (status.last_bad_ms) ESP_LOGI("davis_radio", "Rejected: reason=%s channel=%d RSSI=%d dBm AFC=%d Hz age=%lld ms packet=%s",
    reason, status.last_bad_channel + 1, status.last_bad_rssi_dbm, status.last_bad_afc_hz,
    (long long)(esp_timer_get_time()/1000 - status.last_bad_ms), status.last_bad_packet_hex);
  cJSON *o = cJSON_AddObjectToObject(object, "radio");
  cJSON_AddStringToObject(o, "state", !status.ready ? "unavailable" : status.locked ? "tracking" : "scanning");
  cJSON_AddNumberToObject(o, "transmitterId", status.transmitter_id);
  cJSON_AddNumberToObject(o, "channel", status.channel + 1);
  if (status.packets) {
    cJSON_AddNumberToObject(o, "lastReceivedChannel", status.last_channel + 1);
    cJSON_AddNumberToObject(o, "rssiDbm", status.last_rssi_dbm);
  }
  cJSON_AddNumberToObject(o, "packetsReceived", status.packets);
  cJSON_AddNumberToObject(o, "crcErrors", status.crc_errors);
  cJSON_AddNumberToObject(o, "foreignPackets", status.foreign_packets);
  cJSON_AddNumberToObject(o, "repeaterPackets", status.repeater_packets);
  cJSON_AddNumberToObject(o, "fifoOverruns", status.fifo_overruns);
  cJSON_AddNumberToObject(o, "missedPackets", status.missed_packets);
  cJSON_AddNumberToObject(o, "resyncs", status.resyncs);
  cJSON_AddNumberToObject(o, "spiErrors", status.spi_errors);
  cJSON_AddNumberToObject(o, "stalePackets", status.stale_packets);
  cJSON_AddNumberToObject(o, "maxPollGapMs", (status.max_poll_gap_us + 999) / 1000);
  cJSON_AddNumberToObject(o, "rssiThresholdDbm", status.rssi_threshold_dbm);
  if (status.background_sampled) cJSON_AddNumberToObject(o, "backgroundRssiDbm", status.background_rssi_dbm);
  cJSON_AddNumberToObject(o, "afcHz", status.last_afc_hz);
  cJSON_AddNumberToObject(o, "signalTimeouts", status.receiver_timeouts);
  cJSON_AddNumberToObject(o, "pllTimeouts", status.pll_timeouts);
  if (status.last_bad_ms) {
    cJSON *bad = cJSON_AddObjectToObject(o, "lastRejected");
    cJSON_AddStringToObject(bad, "reason", reason);
    cJSON_AddStringToObject(bad, "packetHex", status.last_bad_packet_hex);
    cJSON_AddNumberToObject(bad, "channel", status.last_bad_channel + 1);
    cJSON_AddNumberToObject(bad, "rssiDbm", status.last_bad_rssi_dbm);
    cJSON_AddNumberToObject(bad, "afcHz", status.last_bad_afc_hz);
    cJSON_AddNumberToObject(bad, "ageMs", esp_timer_get_time()/1000 - status.last_bad_ms);
  }
  cJSON_AddNumberToObject(o, "queuedPackets", queued);
  cJSON_AddNumberToObject(o, "queueDropped", dropped);
  if (status.last_packet_ms) cJSON_AddNumberToObject(o, "lastPacketAgeMs", esp_timer_get_time() / 1000 - status.last_packet_ms);
}
