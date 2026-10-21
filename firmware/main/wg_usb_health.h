#pragma once
#include "nvs.h"
#include "cJSON.h"
typedef const char *(*wg_health_hash_t)(void);
void wg_usb_health_start(const char *boot_id, wg_health_hash_t configuration_hash);
void wg_health_fields(cJSON *object);
