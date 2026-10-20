#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "nvs.h"
#include "cJSON.h"
#include "wg_ota.h"
void wg_credentials_init(nvs_handle_t nvs, wg_ota_sender_t sender, wg_ota_ack_t ack);
const char *wg_credentials_certificate(void);
const char *wg_credentials_id(void);
bool wg_credentials_stage(cJSON *command, const char *id, int64_t deadline, bool busy);
bool wg_credentials_tick(bool connected, bool telemetry_acked, bool busy);
bool wg_credentials_pending(void);
