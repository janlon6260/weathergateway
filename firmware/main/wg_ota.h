#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "nvs.h"
#include "cJSON.h"
typedef void (*wg_ota_sender_t)(const char *suffix, const char *json);
typedef void (*wg_ota_ack_t)(const char *id, const char *status);
void wg_ota_init(nvs_handle_t handle, wg_ota_sender_t sender, wg_ota_ack_t ack);
bool wg_ota_command(cJSON *command, const char *id, int64_t deadline, bool configuration_pending);
void wg_ota_data(cJSON *object);
void wg_ota_tick(bool connected, bool valid_sensor, bool telemetry_acked, bool new_connection);
const char *wg_ota_release(void);
const char *wg_ota_ack_release(const char *command_id);
bool wg_ota_busy(void);
