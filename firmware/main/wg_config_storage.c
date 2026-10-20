#include <stdio.h>
#include <string.h>
#include "wg_config_storage.h"
esp_err_t wg_config_storage(uint32_t address, const char *build_id, nvs_handle_t *handle) {
  char name[16], stored[37]; size_t length = sizeof(stored);
  if (!build_id || strlen(build_id) != 36 || !handle || (address != 0x20000 && address != 0x1a0000)) return ESP_ERR_INVALID_ARG;
  snprintf(name, sizeof(name), "cfg_%lx", (unsigned long)address);
  esp_err_t result = nvs_open(name, NVS_READWRITE, handle);
  if (result != ESP_OK) return result;
  result = nvs_get_str(*handle, "build", stored, &length);
  if (result == ESP_ERR_NVS_NOT_FOUND || (result == ESP_OK && strcmp(stored, build_id))) {
    result = nvs_erase_all(*handle);
    if (result == ESP_OK) result = nvs_set_str(*handle, "build", build_id);
    if (result == ESP_OK) result = nvs_commit(*handle);
  }
  return result;
}
