#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "mqtt_client.h"

typedef struct {
  esp_mqtt_client_handle_t client;
  bool started;
  int64_t retry_at;
  int64_t last_wait_log;
  int waiting;
} wg_mqtt_lifecycle_t;
void wg_mqtt_lifecycle_tick(wg_mqtt_lifecycle_t *state, bool network_up, bool clock_ready, int64_t now_us);
void wg_mqtt_lifecycle_stop(wg_mqtt_lifecycle_t *state);
