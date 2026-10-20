#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "nvs.h"
typedef struct {
  uint64_t number;
  int64_t epoch_ms, monotonic_us;
  uint32_t sequence;
  char boot_id[37], configuration_hash[65], release_id[37];
  uint8_t packet[99], packet_size;
  int8_t channel, rssi;
} wg_spool_record_t;
void wg_spool_init(nvs_handle_t nvs);
bool wg_spool_append(wg_spool_record_t *record);
bool wg_spool_peek(wg_spool_record_t *record);
void wg_spool_ack(uint64_t number);
uint64_t wg_spool_pending(void);
uint64_t wg_spool_dropped(void);
uint32_t wg_spool_capacity(void);
