#pragma once
#include "davis_rfm69.h"
#include "cJSON.h"

typedef struct {
  uint8_t packet[10];
  int channel, rssi_dbm;
  int64_t monotonic_us;
} wg_radio_frame_t;

// One task owns SPI polling. Network/flash consumers never hold its mutex.
void wg_radio_receiver_start(const davis_radio_config_t *config, const char *configuration_hash);
void wg_radio_receiver_stop(void);
bool wg_radio_receiver_read(wg_radio_frame_t *frame);
bool wg_radio_receiver_failed(void);
void wg_radio_receiver_health(cJSON *object);
