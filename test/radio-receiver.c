// Use the actual task body, radio driver and timed FIFO model. The network
// consumer deliberately does no work while the receiver keeps running.
#define main radio_driver_checks
#include "radio-reception.c"
#undef main
#include "../firmware/main/wg_radio_receiver.c"
typedef struct { unsigned length,size,head,count; unsigned char items[16*sizeof(wg_radio_frame_t)]; } host_queue_t;
static host_queue_t host_queue;
static int mutex_held, tasks_created;
SemaphoreHandle_t xSemaphoreCreateMutex(void) { return (void*)1; }
int xSemaphoreTake(SemaphoreHandle_t semaphore,int timeout){(void)semaphore;(void)timeout;assert(!mutex_held);mutex_held=1;return pdTRUE;}
int xSemaphoreGive(SemaphoreHandle_t semaphore){(void)semaphore;assert(mutex_held);mutex_held=0;return pdTRUE;}
QueueHandle_t xQueueCreate(unsigned length,unsigned size){assert(length*size<=sizeof(host_queue.items));host_queue.length=length;host_queue.size=size;return &host_queue;}
int xQueueSend(QueueHandle_t queue,const void *item,int timeout){(void)timeout;host_queue_t *q=queue;if(q->count==q->length)return 0;memcpy(q->items+((q->head+q->count)%q->length)*q->size,item,q->size);q->count++;return pdTRUE;}
int xQueueReceive(QueueHandle_t queue,void *item,int timeout){(void)timeout;host_queue_t *q=queue;if(!q->count)return 0;memcpy(item,q->items+q->head*q->size,q->size);q->head=(q->head+1)%q->length;q->count--;return pdTRUE;}
int xQueueReset(QueueHandle_t queue){host_queue_t *q=queue;q->head=q->count=0;return pdTRUE;}
unsigned uxQueueMessagesWaiting(QueueHandle_t queue){return ((host_queue_t*)queue)->count;}
int xTaskCreate(void (*task)(void *),const char *name,unsigned stack,void *arg,unsigned priority,void *handle){(void)task;(void)name;(void)stack;(void)arg;(void)handle;assert(priority==6);tasks_created++;return pdPASS;}
cJSON *cJSON_AddObjectToObject(cJSON *parent,const char *key){(void)key;return parent;}
void cJSON_AddStringToObject(cJSON *parent,const char *key,const char *value){(void)parent;(void)key;(void)value;}
void cJSON_AddNumberToObject(cJSON *parent,const char *key,double value){(void)parent;(void)key;(void)value;}
int main(void){
  clock_us=1000000;
  davis_radio_config_t config={.sck=18,.miso=19,.mosi=23,.cs=27,.reset=14,.dio0=26,.transmitter_id=1};
  wg_radio_receiver_start(&config,"hash-a");assert(tasks_created==1);
  int sent=0,air_channel=0;int64_t next=clock_us+100000,end=clock_us+45000000;
  while(clock_us<end){
    clock_us+=5000;
    if(clock_us>=next){sent++;assert(channel_index==air_channel);packet_for(1,8);payload=true;air_channel=(air_channel+1)%5;next+=2500000;}
    receiver_step();
  }
  assert(sent==18);assert(stats.packets==18);assert(!wg_radio_receiver_failed());
  assert(uxQueueMessagesWaiting(frames)==16);assert(queue_dropped==2);
  // Restarting MQTT with identical radio config must preserve RF phase and queue.
  int channel=channel_index;wg_radio_receiver_start(&config,"hash-a");assert(channel==channel_index);assert(uxQueueMessagesWaiting(frames)==16);
  wg_radio_frame_t frame;int got=0;int64_t previous=0;
  while(wg_radio_receiver_read(&frame)){assert(frame.monotonic_us>previous);assert(frame.monotonic_us<clock_us);assert(frame.channel==got%5);previous=frame.monotonic_us;got++;}
  assert(got==16);assert(tasks_created==1);
  // Changing the station/pins cannot attach queued old packets to new settings.
  packet_for(1,8);payload=true;receiver_step();assert(uxQueueMessagesWaiting(frames)==1);
  channel=channel_index;wg_radio_receiver_start(&config,"hash-b");assert(uxQueueMessagesWaiting(frames)==0);assert(channel_index==channel);
  packet_for(1,8);payload=true;receiver_step();assert(uxQueueMessagesWaiting(frames)==1);
  config.transmitter_id=2;wg_radio_receiver_start(&config,"hash-c");assert(uxQueueMessagesWaiting(frames)==0);
  wg_radio_receiver_stop();assert(!running);assert(wg_radio_receiver_failed());receiver_step();assert(!wg_radio_receiver_read(&frame));
  puts("radio task: 45-second blocked consumer, bounded overflow, capture timestamps and configuration ownership passed");
  return 0;
}
