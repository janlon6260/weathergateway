// Receive-only RFM69HCW/SX1231 implementation for ESP-IDF.
// Register meanings: HopeRF RFM69HCW V1.1 datasheet.
// Observed ISS sync, bit order and EU hopping: dekay/DavisRFM69.
// Sources and hardware acceptance criteria: docs/davis-radio.md.
#include "davis_rfm69.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>

static const uint32_t eu_channels[] = {0xd90445, 0xd91304, 0xd921c2, 0xd90ba4, 0xd91a63};
static const spi_host_device_t host = SPI2_HOST;
static spi_device_handle_t radio;
static davis_radio_config_t pins;
static bool bus_installed, ready, locked;
static int channel_index, missed;
static int64_t expected_at, scan_at, received_at, retry_at;
static int64_t interval_us;

static bool reg_write(uint8_t address, uint8_t value) {
  uint8_t tx[] = {(uint8_t)(address | 0x80), value};
  spi_transaction_t t = {.length = 16, .tx_buffer = tx};
  if (spi_device_polling_transmit(radio, &t) != ESP_OK) { ready = false; return false; }
  return true;
}
static bool reg_read(uint8_t address, uint8_t *value) {
  uint8_t tx[] = {(uint8_t)(address & 0x7f), 0}, rx[2];
  spi_transaction_t t = {.length = 16, .tx_buffer = tx, .rx_buffer = rx};
  if (spi_device_polling_transmit(radio, &t) != ESP_OK) { ready = false; return false; }
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
  ready = false; return false;
}
static bool receive_on(int channel) {
  channel_index = channel % 5;
  uint32_t frequency = eu_channels[channel_index];
  // Retuning only in standby; clear incomplete/bad packets before resuming.
  return standby() && reg_write(0x07, frequency >> 16) && reg_write(0x08, frequency >> 8) &&
    reg_write(0x09, frequency) && reg_write(0x28, 0x10) && reg_write(0x3d, 0x16) && reg_write(0x01, 0x10);
}
void davis_radio_stop(void) {
  if (radio) { (void)reg_write(0x01, 0x04); spi_bus_remove_device(radio); radio = NULL; }
  if (bus_installed) { spi_bus_free(host); bus_installed = false; }
  ready = false; locked = false; received_at = 0;
}
bool davis_radio_init(const davis_radio_config_t *config) {
  davis_radio_config_t proposed = *config;
  davis_radio_stop(); pins = proposed;
  retry_at = esp_timer_get_time() / 1000 + 30000;
  if (pins.transmitter_id < 1 || pins.transmitter_id > 8) return false;
  gpio_config_t outputs = {.pin_bit_mask = 1ULL << pins.reset, .mode = GPIO_MODE_OUTPUT};
  gpio_config_t input = {.pin_bit_mask = 1ULL << pins.dio0, .mode = GPIO_MODE_INPUT};
  if (gpio_config(&outputs) != ESP_OK || gpio_config(&input) != ESP_OK) return false;
  gpio_set_level(pins.reset, 1); esp_rom_delay_us(200);
  gpio_set_level(pins.reset, 0); vTaskDelay(pdMS_TO_TICKS(10));
  spi_bus_config_t bus = {.mosi_io_num = pins.mosi, .miso_io_num = pins.miso, .sclk_io_num = pins.sck,
    .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 16};
  if (spi_bus_initialize(host, &bus, SPI_DMA_DISABLED) != ESP_OK) return false;
  bus_installed = true;
  spi_device_interface_config_t device = {.clock_speed_hz = 1000000, .mode = 0, .spics_io_num = pins.cs, .queue_size = 1};
  if (spi_bus_add_device(host, &device, &radio) != ESP_OK) return false;
  uint8_t version;
  if (!reg_read(0x10, &version) || version != 0x24 || !standby()) return false;
  // Packet-mode FSK with Gaussian shaping; RX only. Hardware CRC/AES/address
  // filtering are disabled because Davis has its own CRC and ID bit layout.
  const uint8_t registers[][2] = {
    {0x02, 0x02}, // FSK packet mode, BT=0.5
    {0x03, 0x06}, {0x04, 0x83}, // 32 MHz / 0x0683 = 19196 baud
    {0x05, 0x00}, {0x06, 0x4e}, // 4.76 kHz deviation
    {0x0b, 0x00}, {0x11, 0x00}, // No power amplifier enabled
    {0x18, 0x00}, {0x19, 0x4c}, {0x1a, 0x4b}, // 50 ohm, RX 25 kHz / AFC 50 kHz
    {0x1e, 0x0c}, // Automatic AFC, clear for each packet
    {0x25, 0x40}, {0x29, 228}, // DIO0 PayloadReady; datasheet default -114 dBm threshold
    {0x2c, 0x00}, {0x2d, 0x04},
    {0x2e, 0x88}, {0x2f, 0xcb}, {0x30, 0x89}, // Exact 2-byte Davis sync
    {0x37, 0x00}, {0x38, 10}, // Fixed ten-byte payload, manual CRC
    {0x3c, 0x09}, {0x3d, 0x12}, {0x6f, 0x30}, {0x71, 0x00},
  };
  for (unsigned i = 0; i < sizeof(registers) / sizeof(registers[0]); i++)
    if (!reg_write(registers[i][0], registers[i][1])) return false;
  ready = true; locked = false; missed = 0; received_at = 0;
  // ID 1 has wire ID 0. Timer uses microseconds internally below to retain
  // the exact 62.5 ms increment rather than accumulating rounded periods.
  interval_us = 2500000LL + (pins.transmitter_id - 1) * 62500LL;
  scan_at = esp_timer_get_time() / 1000 + 16000;
  if (!receive_on(0)) { ready = false; return false; }
  return true;
}
static uint8_t reverse_bits(uint8_t byte) {
  uint8_t result = 0;
  for (int i = 0; i < 8; i++) { result = (uint8_t)((result << 1) | (byte & 1)); byte >>= 1; }
  return result;
}
static bool valid_frame(const uint8_t packet[10]) {
  if (packet[8] != 255 || packet[9] != 255 || (packet[0] & 7) != pins.transmitter_id - 1) return false;
  uint16_t crc = 0;
  for (int i = 0; i < 8; i++) {
    crc ^= (uint16_t)packet[i] << 8;
    for (int bit = 0; bit < 8; bit++) crc = (uint16_t)((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0));
  }
  return crc == 0;
}
bool davis_radio_failed(int64_t now_ms) { return !ready || received_at == 0 || now_ms - received_at > 15000; }
bool davis_radio_poll(int64_t now_ms, uint8_t packet[10], int *channel, int *rssi_dbm) {
  if (!ready) {
    if (now_ms >= retry_at) (void)davis_radio_init(&pins);
    return false;
  }
  uint8_t flags;
  if (!reg_read(0x28, &flags)) return false;
  if (flags & 0x10) { // FIFO overrun: discard the whole corrupted frame.
    (void)receive_on(channel_index); return false;
  }
  if ((flags & 0x04) && gpio_get_level(pins.dio0)) {
    uint8_t rssi, tx[11] = {0}, rx[11] = {0};
    if (!reg_read(0x24, &rssi) || !standby()) return false;
    spi_transaction_t t = {.length = sizeof(tx) * 8, .tx_buffer = tx, .rx_buffer = rx};
    if (spi_device_polling_transmit(radio, &t) != ESP_OK) { ready = false; return false; }
    for (int i = 0; i < 10; i++) packet[i] = reverse_bits(rx[i + 1]);
    int received_channel = channel_index;
    if (valid_frame(packet)) {
      *channel = received_channel; *rssi_dbm = -(int)rssi / 2;
      received_at = now_ms; expected_at = now_ms * 1000 + interval_us;
      locked = true; missed = 0;
      if (!receive_on(received_channel + 1)) return false;
      return true;
    }
    (void)receive_on(received_channel);
  }
  if (locked && now_ms * 1000 > expected_at + 150000) {
    expected_at += interval_us;
    if (++missed >= 5) { locked = false; scan_at = now_ms + 16000; }
    (void)receive_on(channel_index + 1);
  } else if (!locked && now_ms >= scan_at) {
    scan_at = now_ms + 16000;
    (void)receive_on(channel_index + 1);
  }
  return false;
}
