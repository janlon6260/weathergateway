#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "mqtt_client.h"
void wg_logs_init(const char *boot_id);
void wg_logs_stream(const char *session_id, int64_t until_epoch);
void wg_logs_tick(esp_mqtt_client_handle_t client, bool connected);
bool wg_logs_active(void);
