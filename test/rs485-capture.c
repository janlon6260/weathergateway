#include <assert.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include "../firmware/main/davis_rs485.c"
static int levels[40],deleted,configured_baud,rx_gpio,test_event,test_received,test_stream;
static char captured[512];
static double reported_bytes,reported_errors,reported_omitted;
void test_rs485_log(const char *format,...){va_list args;va_start(args,format);vsnprintf(captured,sizeof(captured),format,args);va_end(args);}
int gpio_set_level(int pin,int level){levels[pin]=level;return 0;}
int gpio_config(const gpio_config_t *config){assert(config->mode==GPIO_MODE_OUTPUT);return 0;}
int uart_driver_delete(int p){assert(p==1);deleted++;return 0;}
int uart_param_config(int p,const uart_config_t *config){assert(p==1);configured_baud=config->baud_rate;return 0;}
int uart_set_pin(int p,int tx,int rx,int rts,int cts){assert(p==1&&tx==-1&&rts==-1&&cts==-1);rx_gpio=rx;return 0;}
int uart_driver_install(int p,int rx,int tx,int size,QueueHandle_t *queue,int flags){assert(p==1&&rx==4096&&tx==0&&size==16);*queue=(void*)1;return 0;}
int uart_read_bytes(int p,void *out,size_t capacity,int timeout){assert(p==1&&timeout==0&&levels[25]==0);if(test_stream){memset(out,0xab,capacity);return (int)capacity;}if(test_received)return 0;unsigned char sample[]={0x80,0x12,0xff,0x00};memcpy(out,sample,4);test_received=1;return 4;}
int xQueueReceive(QueueHandle_t queue,void *out,int timeout){if(!test_event)return 0;((uart_event_t*)out)->type=test_event;test_event=0;return 1;}
cJSON *cJSON_AddObjectToObject(cJSON *o,const char *name){return o;}
void cJSON_AddBoolToObject(cJSON *o,const char *name,int value){assert(value==1);}
void cJSON_AddNumberToObject(cJSON *o,const char *name,double value){if(!strcmp(name,"bytesReceived"))reported_bytes=value;if(!strcmp(name,"uartErrors"))reported_errors=value;if(!strcmp(name,"bytesOmitted"))reported_omitted=value;}
int main(void){
 davis_rs485_start(16,25,26,19200);assert(levels[25]==0&&levels[26]==0&&configured_baud==19200&&rx_gpio==16);
 davis_rs485_poll(200);assert(strstr(captured,"hex=8012FF00"));
 test_event=UART_FRAME_ERR;davis_rs485_poll(400);cJSON json;davis_rs485_health(&json);assert(reported_bytes==4&&reported_errors==1);
 test_stream=1;for(int i=0;i<40;i++)davis_rs485_poll(500+i*50);davis_rs485_health(&json);assert(reported_omitted>0&&levels[25]==0);
 davis_rs485_stop();assert(levels[25]==0&&levels[26]==1&&deleted==1);
 printf("receive-only RS485 diagnostics, raw bytes and bounded overflow OK\n");return 0;
}
