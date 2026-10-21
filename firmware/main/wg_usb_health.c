#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include <stdlib.h>
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/uart.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_flash.h"
#include "provisioning.h"
#include "wg_usb_health.h"
static char boot[37];
static wg_health_hash_t get_hash;
static const char *reset_name(void) {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:return "power_on";case ESP_RST_SW:return "software";
    case ESP_RST_PANIC:return "panic";case ESP_RST_INT_WDT:return "interrupt_watchdog";
    case ESP_RST_TASK_WDT:return "task_watchdog";case ESP_RST_WDT:return "watchdog";
    case ESP_RST_DEEPSLEEP:return "deep_sleep";case ESP_RST_BROWNOUT:return "brownout";
    default:return "unknown";
  }
}
void wg_health_fields(cJSON *o) {
  cJSON_AddStringToObject(o,"bootId",boot);cJSON_AddStringToObject(o,"firmwareVersion","2.3.0");
  cJSON_AddStringToObject(o,"idfVersion",esp_get_idf_version());
  cJSON_AddNumberToObject(o,"uptimeMs",esp_timer_get_time()/1000);
  cJSON_AddNumberToObject(o,"freeHeapBytes",esp_get_free_heap_size());
  cJSON_AddNumberToObject(o,"minimumFreeHeapBytes",esp_get_minimum_free_heap_size());
  cJSON_AddNumberToObject(o,"largestFreeBlockBytes",heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  cJSON_AddNumberToObject(o,"mainTaskStackFreeBytes",uxTaskGetStackHighWaterMark(NULL));
  cJSON_AddStringToObject(o,"resetReason",reset_name());
  uint32_t flash_size=0;if(esp_flash_get_size(NULL,&flash_size)==ESP_OK)cJSON_AddNumberToObject(o,"flashSizeBytes",flash_size);
  if(get_hash)cJSON_AddStringToObject(o,"configurationHash",get_hash());
#ifdef WG_BUILD_ID
  cJSON_AddStringToObject(o,"buildId",WG_BUILD_ID);
#endif
}
static void usb_task(void *unused) {
  (void)unused;char line[96];size_t used=0;bool overflow=false;int64_t last=0;
  for(;;){uint8_t byte;int count=uart_read_bytes(UART_NUM_0,&byte,1,pdMS_TO_TICKS(100));if(count!=1)continue;
    if(byte=='\r')continue;
    if(byte!='\n'){if(used+1<sizeof(line)&&!overflow)line[used++]=(char)byte;else overflow=true;continue;}
    line[used]=0;bool valid=!overflow&&used==46&&!strncmp(line,"WG_BOOT_QUERY ",14);
    for(size_t i=14;valid&&i<46;i++)if(!isxdigit((unsigned char)line[i]))valid=false;
    if(valid&&esp_timer_get_time()-last>500000){cJSON *o=cJSON_CreateObject();
      cJSON_AddStringToObject(o,"challenge",line+14);cJSON_AddStringToObject(o,"stationId",WG_STATION_ID);
      cJSON_AddStringToObject(o,"configurationHash",get_hash());cJSON_AddStringToObject(o,"firmwareVersion","2.3.0");
      cJSON_AddStringToObject(o,"bootId",boot);cJSON_AddStringToObject(o,"status","ready");
      char *json=cJSON_PrintUnformatted(o);if(json){printf("WG_BOOT_READY %s\n",json);fflush(stdout);free(json);}cJSON_Delete(o);last=esp_timer_get_time();
    }
    used=0;overflow=false;
  }
}
void wg_usb_health_start(const char *boot_id,wg_health_hash_t configuration_hash) {
  snprintf(boot,sizeof(boot),"%s",boot_id);get_hash=configuration_hash;
  if(!uart_is_driver_installed(UART_NUM_0)&&uart_driver_install(UART_NUM_0,1024,0,0,NULL,0)!=ESP_OK)return;
  if(xTaskCreate(usb_task,"usb-health",4096,NULL,2,NULL)!=pdPASS)abort();
}
