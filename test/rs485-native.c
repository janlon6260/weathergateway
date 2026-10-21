#include <assert.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include "../firmware/main/davis_rs485.c"
static int levels[40], deleted, configured_baud, rx_gpio, flushes;
static uart_event_t queued[64];
static size_t queued_count, next_event, byte_count, next_byte;
static uint8_t input[4096];
static uint64_t health_frames, health_errors, health_invalid;
void test_rs485_log(const char *format, ...) { (void)format; }
int gpio_set_level(int pin, int level) { levels[pin] = level; return 0; }
int gpio_config(const gpio_config_t *c) { assert(c->mode == GPIO_MODE_OUTPUT); return 0; }
int uart_driver_delete(int p) { assert(p == 1); deleted++; return 0; }
int uart_param_config(int p, const uart_config_t *c) { assert(p == 1); configured_baud = c->baud_rate; return 0; }
int uart_set_pin(int p, int tx, int rx, int rts, int cts) { assert(p == 1 && tx == -1 && rts == -1 && cts == -1); rx_gpio = rx; return 0; }
int uart_driver_install(int p, int rx, int tx, int size, QueueHandle_t *queue, int flags) { assert(p == 1 && rx == 4096 && tx == 0 && size == 32); *queue = (void*)1; return 0; }
int uart_set_rx_full_threshold(int p, int value) { assert(p == 1 && value == 64); return 0; }
int uart_set_rx_timeout(int p, uint8_t value) { assert(p == 1 && value == 20); return 0; }
int uart_read_bytes(int p, void *out, size_t capacity, int timeout) { assert(p == 1 && timeout == 0 && levels[25] == 0); size_t n = byte_count - next_byte; if (n > capacity) n = capacity; memcpy(out,input + next_byte,n); next_byte += n; return (int)n; }
int uart_flush_input(int p) { assert(p == 1); next_byte = byte_count; flushes++; return 0; }
int xQueueReset(QueueHandle_t q) { next_event = queued_count; return 1; }
int xQueueReceive(QueueHandle_t q, void *out, int timeout) { if (next_event == queued_count) return 0; *(uart_event_t*)out = queued[next_event++]; return 1; }
cJSON *cJSON_AddObjectToObject(cJSON *o, const char *name) { return o; }
void cJSON_AddBoolToObject(cJSON *o, const char *name, int value) { (void)value; }
void cJSON_AddStringToObject(cJSON *o, const char *name, const char *value) { if (!strcmp(name,"checksum")) assert(!strcmp(value,"none")); }
void cJSON_AddNumberToObject(cJSON *o, const char *name, double value) { if (!strcmp(name,"framesReceived")) health_frames = value; if (!strcmp(name,"uartErrors")) health_errors = value; if (!strcmp(name,"invalidFrames")) health_invalid = value; }
static void queue(int type, const uint8_t *bytes, size_t size, bool idle) { queued[queued_count++] = (uart_event_t){.type=type,.size=size,.timeout_flag=idle}; if(size){memcpy(input+byte_count,bytes,size);byte_count+=size;} }
int main(void) {
 uint8_t a[6] = {0x80,4,0x70,0x0f,0x99,0}, b[6] = {0xa0,6,0x52,0x83,0x38,0}, out[6];
 davis_rs485_start(16,25,26); assert(levels[25]==0 && levels[26]==0 && configured_baud==4800 && rx_gpio==16);
 assert(davis_rs485_failed(0));
 queue(UART_DATA,a,6,true); queue(UART_DATA,b,6,true);
 assert(davis_rs485_poll(100,out) && !memcmp(out,a,6));
 assert(davis_rs485_poll(100,out) && !memcmp(out,b,6));
 assert(!davis_rs485_poll(101,out) && !davis_rs485_failed(100));
 assert(!davis_rs485_failed(15100) && davis_rs485_failed(15101));
 queue(UART_DATA,a,5,true); assert(!davis_rs485_poll(200,out));
 uint8_t excess[7]={0x80,4,0x70,0x0f,0x99,0,0};queue(UART_DATA,excess,7,true); assert(!davis_rs485_poll(300,out));
 queue(UART_DATA,a,3,false); assert(!davis_rs485_poll(400,out));queue(UART_DATA,a+3,3,true);assert(davis_rs485_poll(450,out)&&!memcmp(out,a,6));
 uint8_t bad[6]={0x30,4,0,0,0,0};queue(UART_DATA,bad,6,true);assert(!davis_rs485_poll(500,out));
 queue(UART_FRAME_ERR,NULL,0,false);queue(UART_DATA,a,6,true);assert(!davis_rs485_poll(600,out));
 queue(UART_PARITY_ERR,NULL,0,false);queue(UART_DATA,a,6,true);assert(!davis_rs485_poll(700,out));
 queue(UART_BREAK,NULL,0,false);queue(UART_DATA,a,6,true);assert(!davis_rs485_poll(800,out));
 uint8_t noise[64];memset(noise,0x80,sizeof(noise));queue(UART_DATA,noise,64,false);queue(UART_DATA,a,6,true);assert(!davis_rs485_poll(900,out));
 queue(UART_DATA,b,6,true);assert(davis_rs485_poll(1000,out)&&!memcmp(out,b,6));
 queue(UART_FIFO_OVF,NULL,0,false);queue(UART_DATA,a,6,true);assert(!davis_rs485_poll(1100,out)&&flushes==1);
 queue(UART_DATA,a,6,true);assert(!davis_rs485_poll(1200,out)); // quarantine until first clean idle after overflow
 queue(UART_DATA,a,6,true);assert(davis_rs485_poll(1300,out));
 cJSON json;davis_rs485_health(&json);assert(health_frames==5 && health_errors==3 && health_invalid>=8);
 davis_rs485_stop();assert(levels[25]==0 && levels[26]==1 && deleted==1 && davis_rs485_failed(1301));
 puts("native RS485 framing, published payloads, idle boundaries, errors, overflow and recovery OK");return 0;
}
