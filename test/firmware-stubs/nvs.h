#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
typedef int nvs_handle_t;
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_NVS_NOT_FOUND 1
#define ESP_ERROR_CHECK(call) do { if ((call) != ESP_OK) abort(); } while (0)
esp_err_t nvs_get_u64(nvs_handle_t,const char *,uint64_t *);
esp_err_t nvs_set_u64(nvs_handle_t,const char *,uint64_t);
esp_err_t nvs_commit(nvs_handle_t);
