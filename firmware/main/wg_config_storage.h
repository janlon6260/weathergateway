#pragma once
#include <stdint.h>
#include "nvs.h"
// Separate namespaces retain the previous OTA slot's confirmed configuration.
esp_err_t wg_config_storage(uint32_t partition_address, const char *build_id, nvs_handle_t *handle);
