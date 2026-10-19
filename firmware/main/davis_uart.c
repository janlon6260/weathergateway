#include "davis_uart.h"
#include "driver/uart.h"
#include "esp_check.h"
#include <string.h>

static const uart_port_t port = UART_NUM_1;
static int state, attempts, used;
static bool installed, prefer_loop2 = true, failed;
static int64_t deadline, next_sample;
static uint8_t receive[100];
static uint16_t crc16(const uint8_t *bytes, int length) {
  uint16_t crc = 0;
  for (int i = 0; i < length; ++i) {
    crc ^= (uint16_t)bytes[i] << 8;
    for (int bit = 0; bit < 8; ++bit) crc = (uint16_t)((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0));
  }
  return crc;
}
void davis_stop(void) {
  if (installed) ESP_ERROR_CHECK(uart_driver_delete(port));
  installed = false;
}
void davis_init(int rx, int tx, int baud) {
  davis_stop();
  uart_config_t config = { .baud_rate = baud, .data_bits = UART_DATA_8_BITS, .parity = UART_PARITY_DISABLE, .stop_bits = UART_STOP_BITS_1, .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT };
  ESP_ERROR_CHECK(uart_param_config(port, &config));
  ESP_ERROR_CHECK(uart_set_pin(port, tx, rx, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
  ESP_ERROR_CHECK(uart_driver_install(port, 1024, 0, 0, NULL, 0));
  installed = true; state = 0; next_sample = 0; attempts = 0; failed = false;
}
bool davis_failed(void) { return failed; }
bool davis_poll(int64_t now, int interval, uint8_t packet[99]) {
  if (state == 0) {
    if (now < next_sample) return false;
    uart_flush_input(port); uart_write_bytes(port, "\n", 1); used = 0; deadline = now + 1200; state = 1;
  }
  if (state == 1) {
    int count = uart_read_bytes(port, receive + used, sizeof(receive) - used, 0);
    if (count < 0) { failed = true; state = 0; next_sample = now + interval * 1000; return false; }
    used += count;
    bool awake = false;
    for (int i = 1; i < used; ++i) if (receive[i - 1] == 10 && receive[i] == 13) awake = true;
    if (awake) {
      uart_flush_input(port);
      const char *request = prefer_loop2 ? "LPS 2 1\n" : "LOOP 1\n";
      uart_write_bytes(port, request, strlen(request)); used = 0; deadline = now + 3500; state = 2;
    } else if (now >= deadline || used == sizeof(receive)) {
      if (++attempts < 3) { state = 0; next_sample = now + 50; } else { failed = true; attempts = 0; state = 0; next_sample = now + interval * 1000; }
    }
  }
  if (state == 2) {
    int count = uart_read_bytes(port, receive + used, sizeof(receive) - used, 0);
    if (count < 0) { failed = true; state = 0; next_sample = now + interval * 1000; return false; }
    used += count;
    // One ACK followed by one complete 99-byte LOOP/LOOP2 frame.
    if (used == 100 && receive[0] == 6 && !memcmp(receive + 1, "LOO", 3) && (receive[5] == 0 || receive[5] == 1) && receive[96] == 10 && receive[97] == 13 && crc16(receive + 1, 99) == 0) {
      memcpy(packet, receive + 1, 99); failed = false; attempts = 0; state = 0; next_sample = now + interval * 1000; return true;
    }
    if (now >= deadline || used == 100) { failed = true; if (prefer_loop2) prefer_loop2 = false; state = 0; next_sample = now + interval * 1000; }
  }
  return false;
}
