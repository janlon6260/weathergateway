#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include "../firmware/main/wg_mqtt_lifecycle.c"
static int starts,stops,fail_start;
void host_log(const char *tag,const char *format,...) { (void)tag;(void)format; }
const char *esp_err_to_name(esp_err_t error) { return error == ESP_OK ? "OK" : "TEST_ERROR"; }
esp_err_t esp_mqtt_client_start(esp_mqtt_client_handle_t handle) { assert(handle); starts++; return fail_start ? ESP_FAIL : ESP_OK; }
esp_err_t esp_mqtt_client_stop(esp_mqtt_client_handle_t handle) { assert(handle); stops++; return ESP_OK; }
int main(void) {
  wg_mqtt_lifecycle_t state={.client=(void*)1};
  // No DNS/TLS work before DHCP and NTP, even if the main loop runs repeatedly.
  for(int i=0;i<100;i++) wg_mqtt_lifecycle_tick(&state,false,false,i*20000);
  for(int i=0;i<100;i++) wg_mqtt_lifecycle_tick(&state,true,false,2000000+i*20000);
  assert(starts==0 && stops==0);
  wg_mqtt_lifecycle_tick(&state,true,true,5000000); assert(starts==1 && state.started);
  wg_mqtt_lifecycle_tick(&state,true,true,6000000); assert(starts==1);
  wg_mqtt_lifecycle_tick(&state,false,true,7000000); assert(stops==1 && !state.started);
  wg_mqtt_lifecycle_tick(&state,false,true,8000000); assert(stops==1);
  fail_start=1; wg_mqtt_lifecycle_tick(&state,true,true,9000000); assert(starts==2 && !state.started);
  wg_mqtt_lifecycle_tick(&state,true,true,10000000); assert(starts==2);
  fail_start=0; wg_mqtt_lifecycle_tick(&state,true,true,14000000); assert(starts==3 && state.started);
  wg_mqtt_lifecycle_tick(&state,true,false,15000000); assert(stops==2 && !state.started);
  wg_mqtt_lifecycle_stop(&state); assert(stops==2);
  puts("MQTT lifecycle: DHCP/NTP gate, disconnect handling and retry backoff passed");
  return 0;
}
