#pragma once
typedef void *QueueHandle_t;
QueueHandle_t xQueueCreate(unsigned length, unsigned item_size);
int xQueueSend(QueueHandle_t queue, const void *item, int timeout);
int xQueueReceive(QueueHandle_t queue, void *item, int timeout);
int xQueueReset(QueueHandle_t queue);
unsigned uxQueueMessagesWaiting(QueueHandle_t queue);
