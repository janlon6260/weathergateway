#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "cJSON.h"
void davis_rs485_start(int rx,int de,int re);
void davis_rs485_stop(void);
bool davis_rs485_poll(int64_t now_ms,uint8_t packet[6]);
bool davis_rs485_failed(int64_t now_ms);
void davis_rs485_health(cJSON *object);
