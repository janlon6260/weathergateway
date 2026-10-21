// Receive-only diagnostics. No ISS frame format or checksum is assumed here.
#include "davis_rs485.h"
#include "driver/uart.h"
#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include <stdio.h>
#include <stdbool.h>
#include <string.h>
static const char *TAG="davis_rs485";
static const uart_port_t port=UART_NUM_1;
static bool installed;
static int driver_enable=-1,receiver_enable=-1,baud_rate;
static QueueHandle_t events;
static uint64_t received,errors,overflows,omitted;
static uint8_t pending[512];
static size_t used;
static int64_t last_log;
void davis_rs485_stop(void){
 if(driver_enable>=0)gpio_set_level(driver_enable,0);
 if(receiver_enable>=0)gpio_set_level(receiver_enable,1);
 if(installed)ESP_ERROR_CHECK(uart_driver_delete(port));
 installed=false;events=NULL;used=0;
}
void davis_rs485_start(int rx,int de,int re,int baud){
 davis_rs485_stop();driver_enable=de;receiver_enable=re;baud_rate=baud;
 // Hold the transceiver's driver disabled before connecting UART RX.
 gpio_config_t pins={.pin_bit_mask=(1ULL<<de)|(1ULL<<re),.mode=GPIO_MODE_OUTPUT,.pull_up_en=GPIO_PULLUP_DISABLE,.pull_down_en=GPIO_PULLDOWN_ENABLE,.intr_type=GPIO_INTR_DISABLE};
 ESP_ERROR_CHECK(gpio_config(&pins));ESP_ERROR_CHECK(gpio_set_level(de,0));ESP_ERROR_CHECK(gpio_set_level(re,0));
 uart_config_t config={.baud_rate=baud,.data_bits=UART_DATA_8_BITS,.parity=UART_PARITY_DISABLE,.stop_bits=UART_STOP_BITS_1,.flow_ctrl=UART_HW_FLOWCTRL_DISABLE,.source_clk=UART_SCLK_DEFAULT};
 ESP_ERROR_CHECK(uart_param_config(port,&config));
 ESP_ERROR_CHECK(uart_set_pin(port,UART_PIN_NO_CHANGE,rx,UART_PIN_NO_CHANGE,UART_PIN_NO_CHANGE));
 ESP_ERROR_CHECK(uart_driver_install(port,4096,0,16,&events,0));
 installed=true;used=0;last_log=0;
 ESP_LOGI(TAG,"ISS_RS485_CAPTURE started: baud=%d RX=%d DE=%d /RE=%d; receive-only; weather decoding NOT enabled",baud,rx,de,re);
}
void davis_rs485_poll(int64_t now){
 if(!installed)return;
 uart_event_t event;while(xQueueReceive(events,&event,0)==pdTRUE){if(event.type==UART_FIFO_OVF||event.type==UART_BUFFER_FULL)overflows++;else if(event.type==UART_FRAME_ERR||event.type==UART_PARITY_ERR)errors++;}
 uint8_t bytes[128];int count=uart_read_bytes(port,bytes,sizeof(bytes),0);
 if(count<0){errors++;return;}received+=(unsigned)count;
 for(int i=0;i<count;i++){if(used<sizeof(pending))pending[used++]=bytes[i];else omitted++;}
 if(used&&now-last_log>=200){size_t size=used<64?used:64;char hex[129];for(size_t i=0;i<size;i++)snprintf(hex+i*2,3,"%02X",pending[i]);
  ESP_LOGI(TAG,"ISS_RS485_CAPTURE baud=%d bytes=%u hex=%s",baud_rate,(unsigned)size,hex);
  memmove(pending,pending+size,used-size);used-=size;last_log=now;
 }
}
void davis_rs485_health(cJSON *object){if(!installed)return;cJSON *o=cJSON_AddObjectToObject(object,"rs485");cJSON_AddBoolToObject(o,"captureOnly",true);cJSON_AddNumberToObject(o,"baud",baud_rate);cJSON_AddNumberToObject(o,"bytesReceived",received);cJSON_AddNumberToObject(o,"uartErrors",errors);cJSON_AddNumberToObject(o,"overflows",overflows);cJSON_AddNumberToObject(o,"bytesOmitted",omitted);}
