// Native cabled ISS: 4800 8N1, six payload bytes, no checksum on the bus.
// Independent implementation of dwall's published observations (2017-08-21).
// Sources, framing limits and wiring: docs/davis-rs485.md.
#include "davis_rs485.h"
#include "driver/uart.h"
#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include <stdio.h>
#include <string.h>
static const char *TAG = "davis_rs485";
static const uart_port_t port = UART_NUM_1;
static bool installed, dirty, has_frame;
static int driver_enable = -1, receiver_enable = -1;
static QueueHandle_t events;
static uint64_t received, errors, overflows, accepted, rejected;
static uint8_t frame[6];
static size_t used;
static int64_t last_frame;
static bool known_header(uint8_t byte) {
  switch (byte >> 4) { case 4: case 5: case 6: case 8: case 9: case 10: case 14: return true; default: return false; }
}
void davis_rs485_stop(void) {
  if (driver_enable >= 0) gpio_set_level(driver_enable, 0);
  if (receiver_enable >= 0) gpio_set_level(receiver_enable, 1);
  if (installed) ESP_ERROR_CHECK(uart_driver_delete(port));
  installed = false; events = NULL; used = 0; dirty = false; has_frame = false;
}
void davis_rs485_start(int rx, int de, int re) {
  davis_rs485_stop(); driver_enable = de; receiver_enable = re;
  gpio_config_t pins = { .pin_bit_mask = (1ULL << de) | (1ULL << re), .mode = GPIO_MODE_OUTPUT, .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_ENABLE, .intr_type = GPIO_INTR_DISABLE };
  ESP_ERROR_CHECK(gpio_config(&pins));
  ESP_ERROR_CHECK(gpio_set_level(de, 0)); ESP_ERROR_CHECK(gpio_set_level(re, 0));
  uart_config_t config = { .baud_rate = 4800, .data_bits = UART_DATA_8_BITS, .parity = UART_PARITY_DISABLE, .stop_bits = UART_STOP_BITS_1, .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT };
  ESP_ERROR_CHECK(uart_param_config(port, &config));
  ESP_ERROR_CHECK(uart_set_pin(port, UART_PIN_NO_CHANGE, rx, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
  ESP_ERROR_CHECK(uart_driver_install(port, 4096, 0, 32, &events, 0));
  installed = true;
  // One frame is about 12.5 ms; hardware idle timeout separates bursts even
  // when MQTT blocks the application loop. Never infer boundaries from poll time.
  ESP_ERROR_CHECK(uart_set_rx_full_threshold(port, 64));
  ESP_ERROR_CHECK(uart_set_rx_timeout(port, 20));
  ESP_LOGI(TAG, "ISS RS-485 started: 4800 8N1 RX=%d DE=%d /RE=%d; six-byte frames, no bus checksum; transmitter disabled", rx, de, re);
}
static void discard(void) {
  ESP_ERROR_CHECK(uart_flush_input(port)); xQueueReset(events);
  used = 0; dirty = true;
}
bool davis_rs485_poll(int64_t now, uint8_t packet[6]) {
  if (!installed) return false;
  uart_event_t event;
  while (xQueueReceive(events, &event, 0) == pdTRUE) {
    if (event.type == UART_FIFO_OVF || event.type == UART_BUFFER_FULL) { overflows++; rejected++; discard(); continue; }
    if (event.type == UART_FRAME_ERR || event.type == UART_PARITY_ERR || event.type == UART_BREAK) { errors++; dirty = true; continue; }
    if (event.type != UART_DATA) continue;
    size_t remaining = event.size;
    while (remaining) {
      uint8_t bytes[64]; size_t length = remaining < sizeof(bytes) ? remaining : sizeof(bytes);
      int count = uart_read_bytes(port, bytes, length, 0);
      if (count <= 0 || (size_t)count > length) { errors++; rejected++; discard(); return false; }
      received += (unsigned)count; remaining -= (unsigned)count;
      for (int i = 0; i < count; ++i) {
        if (used < sizeof(frame)) frame[used++] = bytes[i]; else dirty = true;
      }
    }
    if (!event.timeout_flag) continue;
    bool valid = !dirty && used == sizeof(frame) && known_header(frame[0]);
    used = 0; dirty = false;
    if (!valid) { rejected++; continue; }
    memcpy(packet, frame, sizeof(frame)); accepted++; has_frame = true; last_frame = now;
    ESP_LOGI(TAG, "ISS_RS485_FRAME hex=%02X%02X%02X%02X%02X%02X", frame[0], frame[1], frame[2], frame[3], frame[4], frame[5]);
    return true;
  }
  return false;
}
bool davis_rs485_failed(int64_t now) { return !installed || !has_frame || now < last_frame || now - last_frame > 15000; }
void davis_rs485_health(cJSON *object) {
  if (!installed) return;
  cJSON *o = cJSON_AddObjectToObject(object, "rs485");
  cJSON_AddStringToObject(o, "protocol", "davis-iss-rs485-v1"); cJSON_AddStringToObject(o, "checksum", "none");
  cJSON_AddNumberToObject(o, "baud", 4800); cJSON_AddNumberToObject(o, "bytesReceived", received);
  cJSON_AddNumberToObject(o, "framesReceived", accepted); cJSON_AddNumberToObject(o, "invalidFrames", rejected);
  cJSON_AddNumberToObject(o, "uartErrors", errors); cJSON_AddNumberToObject(o, "overflows", overflows);
}
