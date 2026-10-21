// Receive-only RFM69HCW/SX1231 implementation for ESP-IDF.
// Register meanings: HopeRF RFM69HCW V1.1 datasheet.
// Observed ISS sync, bit order and EU hopping: dekay/DavisRFM69.
// Sources and hardware acceptance criteria: docs/davis-radio.md.
#include "davis_rfm69.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>
#include <stdio.h>

static const uint32_t eu_channels[] = {0xd90445, 0xd91304, 0xd921c2, 0xd90ba4, 0xd91a63};
static const spi_host_device_t host = SPI2_HOST;
static spi_device_handle_t radio;
static davis_radio_config_t pins;
static bool bus_installed, ready, locked;
static bool reset_configured, dio_configured;
static const char *TAG = "davis_radio";
static int channel_index, missed;
static int64_t expected_at, scan_at, received_at, retry_at;
static int64_t interval_us;
static int64_t last_poll_us;
static int64_t background_at;
static davis_radio_stats_t stats;

static void fault(void) { ready = false; retry_at = esp_timer_get_time() / 1000 + 30000; }
static bool valid_pin(int pin) {
  const int valid[] = {13,14,16,17,18,19,21,22,23,25,26,27,32,33};
  for (unsigned i = 0; i < sizeof(valid)/sizeof(valid[0]); i++) if (pin == valid[i]) return true;
  return false;
}

static bool reg_write(uint8_t address, uint8_t value) {
  uint8_t tx[] = {(uint8_t)(address | 0x80), value};
  spi_transaction_t t = {.length = 16, .tx_buffer = tx};
  if (spi_device_polling_transmit(radio, &t) != ESP_OK) { stats.spi_errors++; fault(); return false; }
  return true;
}
static bool reg_read(uint8_t address, uint8_t *value) {
  uint8_t tx[] = {(uint8_t)(address & 0x7f), 0}, rx[2];
  spi_transaction_t t = {.length = 16, .tx_buffer = tx, .rx_buffer = rx};
  if (spi_device_polling_transmit(radio, &t) != ESP_OK) { stats.spi_errors++; fault(); return false; }
  *value = rx[1]; return true;
}
static bool standby(void) {
  if (!reg_write(0x01, 0x04)) return false;
  int64_t deadline = esp_timer_get_time() + 50000;
  do {
    uint8_t flags;
    if (!reg_read(0x27, &flags)) return false;
    if (flags & 0x80) return true;
    vTaskDelay(1);
  } while (esp_timer_get_time() < deadline);
  fault(); return false;
}
static bool receive_on(int channel) {
  channel_index = channel % 5;
  uint32_t frequency = eu_channels[channel_index];
  // Retuning only in standby; clear incomplete/bad packets before resuming.
  if (!standby() || !reg_write(0x07, frequency >> 16) || !reg_write(0x08, frequency >> 8) ||
      !reg_write(0x09, frequency) || !reg_write(0x01, 0x08)) return false;
  // Explicitly relock the synthesizer before RX (datasheet 4.2.5). A successful
  // SPI write alone is not evidence that the receiver reached the new channel.
  const int64_t deadline = esp_timer_get_time() + 50000;
  for (;;) {
    uint8_t flags;
    if (!reg_read(0x27, &flags)) return false;
    if ((flags & 0x90) == 0x90) break;
    if (esp_timer_get_time() >= deadline) { stats.pll_timeouts++; fault(); return false; }
    vTaskDelay(1);
  }
  uint8_t a, b, c;
  if (!reg_read(0x07, &a) || !reg_read(0x08, &b) || !reg_read(0x09, &c)) return false;
  if ((((uint32_t)a << 16) | ((uint32_t)b << 8) | c) != frequency) {
    stats.spi_errors++; fault(); return false;
  }
  return reg_write(0x28, 0x10) && reg_write(0x3d, 0x12) && reg_write(0x01, 0x10);
}
void davis_radio_stop(void) {
  if (radio) { (void)reg_write(0x01, 0x04); spi_bus_remove_device(radio); radio = NULL; }
  if (bus_installed) { spi_bus_free(host); bus_installed = false; }
  // gpio_config() reserves output pins in IDF 6.1. Release only pins owned by this driver.
  if (reset_configured) { gpio_reset_pin(pins.reset); reset_configured = false; }
  if (dio_configured) { gpio_reset_pin(pins.dio0); dio_configured = false; }
  ready = false; locked = false; received_at = 0;
}
static bool init_failed(const char *stage, esp_err_t error) {
  davis_radio_stop(); fault();
  ESP_LOGE(TAG, "RFM69 initialization failed at %s: %s. Check 3.3V, ground and wiring; retrying in 30 seconds", stage, esp_err_to_name(error));
  return false;
}
bool davis_radio_init(const davis_radio_config_t *config) {
  if (!config || config->transmitter_id < 1 || config->transmitter_id > 8) return false;
  if (config->rssi_threshold_dbm && (config->rssi_threshold_dbm < -120 || config->rssi_threshold_dbm > -40)) return false;
  int assigned[] = {config->sck, config->miso, config->mosi, config->cs, config->reset, config->dio0};
  for (unsigned i = 0; i < 6; i++) {
    if (!valid_pin(assigned[i])) return false;
    for (unsigned j = 0; j < i; j++) if (assigned[i] == assigned[j]) return false;
  }
  davis_radio_config_t proposed = *config;
  davis_radio_stop(); pins = proposed;
  stats.rssi_threshold_dbm = pins.rssi_threshold_dbm ? pins.rssi_threshold_dbm : -85;
  retry_at = esp_timer_get_time() / 1000 + 30000;
  gpio_config_t outputs = {.pin_bit_mask = 1ULL << pins.reset, .mode = GPIO_MODE_OUTPUT};
  gpio_config_t input = {.pin_bit_mask = 1ULL << pins.dio0, .mode = GPIO_MODE_INPUT};
  esp_err_t error = gpio_config(&outputs);
  if (error != ESP_OK) return init_failed("reset GPIO", error);
  reset_configured = true;
  error = gpio_config(&input);
  if (error != ESP_OK) return init_failed("DIO0 GPIO", error);
  dio_configured = true;
  gpio_set_level(pins.reset, 1); esp_rom_delay_us(200);
  gpio_set_level(pins.reset, 0); vTaskDelay(pdMS_TO_TICKS(10));
  spi_bus_config_t bus = {.mosi_io_num = pins.mosi, .miso_io_num = pins.miso, .sclk_io_num = pins.sck,
    .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 16};
  error = spi_bus_initialize(host, &bus, SPI_DMA_DISABLED);
  if (error != ESP_OK) return init_failed("SPI bus", error);
  bus_installed = true;
  spi_device_interface_config_t device = {.clock_speed_hz = 1000000, .mode = 0, .spics_io_num = pins.cs, .queue_size = 1};
  error = spi_bus_add_device(host, &device, &radio);
  if (error != ESP_OK) return init_failed("SPI device", error);
  uint8_t version;
  if (!reg_read(0x10, &version)) return init_failed("register read", ESP_FAIL);
  if (version != 0x24) {
    ESP_LOGE(TAG, "RFM69 RegVersion=0x%02x; expected 0x24 (CS=%d SCK=%d MISO=%d MOSI=%d RST=%d DIO0=%d)", version, pins.cs, pins.sck, pins.miso, pins.mosi, pins.reset, pins.dio0);
    return init_failed("chip identification", ESP_ERR_NOT_FOUND);
  }
  if (!standby()) return init_failed("standby", ESP_ERR_TIMEOUT);
  // Packet-mode FSK with Gaussian shaping; RX only. Hardware CRC/AES/address
  // filtering are disabled because Davis has its own CRC and ID bit layout.
  const uint8_t registers[][2] = {
    {0x02, 0x02}, // FSK packet mode, BT=0.5
    {0x03, 0x06}, {0x04, 0x83}, // 32 MHz / 0x0683 = 19196 baud
    {0x05, 0x00}, {0x06, 0x4e}, // 4.76 kHz deviation
    {0x0b, 0x00}, {0x11, 0x00}, // No power amplifier enabled
    {0x18, 0x00}, {0x19, 0x4c}, {0x1a, 0x4b}, // 50 ohm, RX 25 kHz / AFC 50 kHz
    {0x1e, 0x0c}, // Automatic AFC, clear for each packet
    {0x25, 0x40}, {0x29, (uint8_t)(-2 * stats.rssi_threshold_dbm)}, // Davis reference: -85 dBm, configurable
    {0x2a, 0x00}, {0x2b, 32}, // No idle timeout; signal without payload times out after ~26.7 ms
    {0x2c, 0x00}, {0x2d, 0x04},
    {0x2e, 0x8a}, {0x2f, 0xcb}, {0x30, 0x89}, // Reference sync tolerance: two bits; payload CRC remains mandatory
    {0x37, 0x00}, {0x38, 10}, // Fixed ten-byte payload, manual CRC
    {0x3c, 0x09}, {0x3d, 0x12}, {0x6f, 0x30}, {0x71, 0x00},
  };
  for (unsigned i = 0; i < sizeof(registers) / sizeof(registers[0]); i++)
    if (!reg_write(registers[i][0], registers[i][1])) return init_failed("register configuration", ESP_FAIL);
  ready = true; locked = false; missed = 0; received_at = 0;
  last_poll_us = esp_timer_get_time();
  background_at = last_poll_us / 1000 + 500;
  // ID 1 has wire ID 0. Timer uses microseconds internally below to retain
  // the exact 62.5 ms increment rather than accumulating rounded periods.
  interval_us = 2500000LL + (pins.transmitter_id - 1) * 62500LL;
  scan_at = esp_timer_get_time() / 1000 + 16000;
  if (!receive_on(0)) return init_failed("receiver", ESP_FAIL);
  ESP_LOGI(TAG, "RFM69 ready: EU868, ISS ID %d, RSSI trigger=%d dBm, signal timeout=26.7 ms", pins.transmitter_id, stats.rssi_threshold_dbm);
  return true;
}
static uint8_t reverse_bits(uint8_t byte) {
  uint8_t result = 0;
  for (int i = 0; i < 8; i++) { result = (uint8_t)((result << 1) | (byte & 1)); byte >>= 1; }
  return result;
}
static bool valid_frame(const uint8_t packet[10]) {
  uint16_t crc = 0;
  for (int i = 0; i < 8; i++) {
    crc ^= (uint16_t)packet[i] << 8;
    for (int bit = 0; bit < 8; bit++) crc = (uint16_t)((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0));
  }
  if (crc) { stats.crc_errors++; stats.last_bad_reason = 1; return false; }
  if (packet[8] != 255 || packet[9] != 255) { stats.repeater_packets++; stats.last_bad_reason = 2; return false; }
  if ((packet[0] & 7) != pins.transmitter_id - 1) { stats.foreign_packets++; stats.last_bad_reason = 3; return false; }
  return true;
}
bool davis_radio_failed(int64_t now_ms) { return !ready || received_at == 0 || now_ms - received_at > 15000; }
void davis_radio_stats(davis_radio_stats_t *out) {
  *out = stats; out->ready = ready; out->locked = locked;
  out->transmitter_id = pins.transmitter_id; out->channel = channel_index;
  out->last_packet_ms = received_at;
}
bool davis_radio_poll(int64_t now_ms, uint8_t packet[10], int *channel, int *rssi_dbm) {
  if (!ready) {
    if (now_ms >= retry_at) (void)davis_radio_init(&pins);
    return false;
  }
  const int64_t now_us = now_ms * 1000;
  if (last_poll_us && now_us > last_poll_us && (uint64_t)(now_us - last_poll_us) > stats.max_poll_gap_us)
    stats.max_poll_gap_us = now_us - last_poll_us;
  last_poll_us = now_us;
  uint8_t flags;
  if (!reg_read(0x28, &flags)) return false;
  const bool late = locked && now_us > expected_at + 150000;
  if (flags & 0x10) { // Errors must not starve the scheduled hop below.
    stats.fifo_overruns++;
    if (!receive_on(channel_index)) return false;
  } else if ((flags & 0x04) && late) {
    // The FIFO can retain a frame while its consumer is stalled. Its read time
    // is not its RF arrival time; never re-anchor the hop clock to stale data.
    stats.stale_packets++;
    if (!receive_on(channel_index)) return false;
  }
  else if (flags & 0x04) {
    uint8_t rssi, afc_msb, afc_lsb, tx[11] = {0}, rx[11] = {0};
    if (!reg_read(0x24, &rssi) || !reg_read(0x1f, &afc_msb) || !reg_read(0x20, &afc_lsb) || !standby()) return false;
    const int afc_hz = (int32_t)(int16_t)(((uint16_t)afc_msb << 8) | afc_lsb) * 32000000LL / 524288;
    spi_transaction_t t = {.length = sizeof(tx) * 8, .tx_buffer = tx, .rx_buffer = rx};
    if (spi_device_polling_transmit(radio, &t) != ESP_OK) { stats.spi_errors++; fault(); return false; }
    for (int i = 0; i < 10; i++) packet[i] = reverse_bits(rx[i + 1]);
    int received_channel = channel_index;
    if (valid_frame(packet)) {
      *channel = received_channel; *rssi_dbm = -(int)rssi / 2;
      received_at = now_ms; expected_at = now_ms * 1000 + interval_us;
      stats.packets++; stats.last_channel = received_channel; stats.last_rssi_dbm = *rssi_dbm;
      stats.last_afc_hz = afc_hz;
      locked = true; missed = 0;
      if (!receive_on(received_channel + 1)) return false;
      return true;
    }
    for (int i = 0; i < 10; i++) snprintf(stats.last_bad_packet_hex + 2*i, 3, "%02x", packet[i]);
    stats.last_bad_ms = now_ms; stats.last_bad_channel = received_channel;
    stats.last_bad_rssi_dbm = -(int)rssi / 2; stats.last_bad_afc_hz = afc_hz;
    if (!receive_on(received_channel)) return false;
  } else {
    uint8_t irq1;
    if (!reg_read(0x27, &irq1)) return false;
    // AGC/AFC can be triggered by interference with no subsequent complete
    // packet. AutoRxRestart only runs after a drained payload, so handle the
    // hardware signal timeout explicitly; retain the hop schedule and channel.
    if (irq1 & 0x04) {
      stats.receiver_timeouts++;
      if (!receive_on(channel_index)) return false;
    } else if (now_ms >= background_at && (!locked || now_us < expected_at - 50000)) {
      uint8_t rssi;
      if (!reg_read(0x24, &rssi)) return false;
      stats.background_rssi_dbm = -(int)rssi / 2; stats.background_sampled = true;
      background_at = now_ms + 500;
    }
  }
  if (late) {
    // Catch up all elapsed slots in one poll, rather than hopping once per
    // delayed loop. Retain phase through short RF outages (up to 25 slots).
    const int64_t slots = (now_us - expected_at - 150000) / interval_us + 1;
    expected_at += slots * interval_us; stats.missed_packets += slots;
    if (slots >= 25 - missed) { locked = false; missed = 25; scan_at = now_ms + 16000; stats.resyncs++; }
    else missed += (int)slots;
    (void)receive_on(channel_index + (int)(slots % 5));
  } else if (!locked && now_ms >= scan_at) {
    scan_at = now_ms + 16000;
    (void)receive_on(channel_index + 1);
  }
  return false;
}
