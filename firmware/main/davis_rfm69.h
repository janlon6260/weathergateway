#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
  int sck, miso, mosi, cs, reset, dio0;
  int transmitter_id; // Human-readable Davis ID 1..8; wire ID is 0..7.
} davis_radio_config_t;

typedef struct {
  bool ready, locked;
  int transmitter_id, channel, last_channel, last_rssi_dbm;
  int64_t last_packet_ms;
  uint64_t packets, crc_errors, foreign_packets, repeater_packets, fifo_overruns;
  uint64_t missed_packets, resyncs, spi_errors, stale_packets, max_poll_gap_us;
} davis_radio_stats_t;

bool davis_radio_init(const davis_radio_config_t *config);
void davis_radio_stop(void);
// Non-blocking reception; call every 20 ms or faster. Bytes are normalized
// (on-air bits reversed), CRC checked and restricted to the configured ID.
bool davis_radio_poll(int64_t now_ms, uint8_t packet[10], int *channel, int *rssi_dbm);
bool davis_radio_failed(int64_t now_ms);
// Same owner/lock as poll(), init() and stop(). Channels use wire numbering 0..4.
void davis_radio_stats(davis_radio_stats_t *out);
