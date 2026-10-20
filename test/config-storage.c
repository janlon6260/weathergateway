#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "nvs.h"
static struct { char build[37], value[100]; } slots[2];
static int failure;
esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *out) { (void)mode; if (failure) return ESP_FAIL; *out = !strcmp(name,"cfg_20000") ? 0 : 1; return ESP_OK; }
esp_err_t nvs_get_str(nvs_handle_t h,const char *key,char *out,size_t *size) { (void)key; if (!slots[h].build[0]) return ESP_ERR_NVS_NOT_FOUND; assert(*size >= 37); strcpy(out,slots[h].build); return ESP_OK; }
esp_err_t nvs_set_str(nvs_handle_t h,const char *key,const char *value) { (void)key; strcpy(slots[h].build,value); return ESP_OK; }
esp_err_t nvs_erase_all(nvs_handle_t h) { memset(&slots[h],0,sizeof(slots[h])); return ESP_OK; }
esp_err_t nvs_commit(nvs_handle_t h) { (void)h; return ESP_OK; }
#include "../firmware/main/wg_config_storage.c"
int main(void) {
  nvs_handle_t first, candidate, reboot;
  const char *old = "11111111-1111-4111-8111-111111111111", *next = "22222222-2222-4222-8222-222222222222", *third = "33333333-3333-4333-8333-333333333333";
  assert(wg_config_storage(0x20000, old, &first) == ESP_OK); strcpy(slots[first].value,"confirmed-old-gateway");
  assert(wg_config_storage(0x1a0000, next, &candidate) == ESP_OK); assert(!slots[candidate].value[0]); strcpy(slots[candidate].value,"test-new-gateway");
  assert(wg_config_storage(0x20000, old, &reboot) == ESP_OK); assert(!strcmp(slots[reboot].value,"confirmed-old-gateway"));
  assert(wg_config_storage(0x1a0000, next, &reboot) == ESP_OK); assert(!strcmp(slots[reboot].value,"test-new-gateway"));
  assert(wg_config_storage(0x1a0000, third, &reboot) == ESP_OK); assert(!slots[reboot].value[0]); assert(!strcmp(slots[first].value,"confirmed-old-gateway"));
  assert(wg_config_storage(0x1000, next, &reboot) == ESP_ERR_INVALID_ARG);
  assert(wg_config_storage(0x20000, "bad", &reboot) == ESP_ERR_INVALID_ARG);
  failure = 1; assert(wg_config_storage(0x20000,old,&reboot) == ESP_FAIL);
  puts("OTA configuration storage keeps rollback settings and resets reused slots"); return 0;
}
