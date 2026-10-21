#pragma once
#include <stdint.h>
#include "cJSON.h"
void davis_rs485_start(int rx,int de,int re,int baud);
void davis_rs485_stop(void);
void davis_rs485_poll(int64_t now_ms);
void davis_rs485_health(cJSON *object);
