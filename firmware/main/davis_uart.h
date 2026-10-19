#pragma once
#include <stdbool.h>
#include <stdint.h>

void davis_init(int rx, int tx, int baud);
void davis_stop(void);
// Non-blocking: call at least every 50 ms. True means one CRC-checked frame.
bool davis_poll(int64_t now_ms, int interval_seconds, uint8_t packet[99]);
bool davis_failed(void);
