#pragma once
#include "esp_err.h"
typedef void *esp_mqtt_client_handle_t;
esp_err_t esp_mqtt_client_start(esp_mqtt_client_handle_t handle);
esp_err_t esp_mqtt_client_stop(esp_mqtt_client_handle_t handle);
