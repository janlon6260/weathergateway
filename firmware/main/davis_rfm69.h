#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
  int sck, miso, mosi, cs, reset, dio0;
  int transmitter_id; // Human-readable Davis ID 1..8; wire ID is 0..7.
} davis_radio_config_t;

bool davis_radio_init(const davis_radio_config_t *config);
void davis_radio_stop(void);
// Non-blocking reception; call every 20 ms or faster. Bytes are normalized
// (on-air bits reversed), CRC checked and restricted to the configured ID.
bool davis_radio_poll(int64_t now_ms, uint8_t packet[10], int *channel, int *rssi_dbm);
bool davis_radio_failed(int64_t now_ms);
