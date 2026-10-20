// Exercise the real radio driver with GPIO reservations as in ESP-IDF 6.1.
#include <assert.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include "../firmware/main/davis_rfm69.c"

static int64_t clock_us;
static uint64_t reserved;
static int conflicts, configured, fail_gpio, fail_bus, fail_device, spi_fault, version_value=0x24;
static bool bus_owned, device_owned;
const char *esp_err_to_name(esp_err_t error) { return error == ESP_OK ? "OK" : "TEST_ERROR"; }
void host_log(const char *tag, const char *format, ...) { (void)tag; (void)format; }
int64_t esp_timer_get_time(void) { return clock_us; }
void esp_rom_delay_us(unsigned us) { clock_us += us; }
void vTaskDelay(int ms) { clock_us += ms*1000; }
esp_err_t gpio_config(const gpio_config_t *config) {
  if (++configured == fail_gpio) return ESP_FAIL;
  if (reserved & config->pin_bit_mask) conflicts++;
  reserved |= config->pin_bit_mask;
  return ESP_OK;
}
esp_err_t gpio_reset_pin(int pin) { assert(reserved & (1ULL<<pin)); reserved &= ~(1ULL<<pin); return ESP_OK; }
esp_err_t gpio_set_level(int pin, int level) { (void)level; assert(reserved & (1ULL<<pin)); return ESP_OK; }
int gpio_get_level(int pin) { (void)pin; return 0; }
esp_err_t spi_bus_initialize(spi_host_device_t bus, const spi_bus_config_t *config, int dma) {
  (void)bus; (void)config; (void)dma; assert(!bus_owned);
  if (fail_bus) return ESP_FAIL; bus_owned=true; return ESP_OK;
}
esp_err_t spi_bus_add_device(spi_host_device_t bus, const spi_device_interface_config_t *config, spi_device_handle_t *out) {
  (void)bus; (void)config; assert(bus_owned && !device_owned);
  if (fail_device) return ESP_FAIL; device_owned=true; *out=(void*)1; return ESP_OK;
}
esp_err_t spi_bus_remove_device(spi_device_handle_t handle) { assert(handle && device_owned); device_owned=false; return ESP_OK; }
esp_err_t spi_bus_free(spi_host_device_t bus) { (void)bus; assert(bus_owned && !device_owned); bus_owned=false; return ESP_OK; }
esp_err_t spi_device_polling_transmit(spi_device_handle_t handle, spi_transaction_t *t) {
  assert(handle && device_owned);
  if (spi_fault) return ESP_FAIL;
  const unsigned char *tx=t->tx_buffer;
  if (t->rx_buffer && t->length == 16) {
    unsigned char *rx=t->rx_buffer; rx[0]=0;
    rx[1]=tx[0] == 0x10 ? version_value : tx[0] == 0x27 ? 0x80 : 0;
  }
  return ESP_OK;
}
static void clean(void) { assert(!bus_owned && !device_owned && !reserved && !conflicts); }
int main(void) {
  davis_radio_config_t config={.sck=18,.miso=19,.mosi=23,.cs=27,.reset=14,.dio0=26,.transmitter_id=1};
  // Version mismatch must release GPIO14 and all SPI resources on every retry.
  version_value=0xff;
  assert(!davis_radio_init(&config)); clean();
  for (int i=0;i<5;i++) {
    clock_us=retry_at*1000; unsigned char packet[10]; int channel,rssi;
    assert(!davis_radio_poll(clock_us/1000,packet,&channel,&rssi)); clean();
  }
  version_value=0x24;
  assert(davis_radio_init(&config)); assert(ready);
  davis_radio_stop(); clean(); davis_radio_stop(); clean();
  // Partial setup failure must not leave a GPIO reservation behind.
  fail_gpio=configured+2; assert(!davis_radio_init(&config)); clean(); fail_gpio=0;
  fail_bus=1; assert(!davis_radio_init(&config)); clean(); fail_bus=0;
  fail_device=1; assert(!davis_radio_init(&config)); clean(); fail_device=0;
  spi_fault=1; assert(!davis_radio_init(&config)); clean(); spi_fault=0;
  assert(davis_radio_init(&config));
  config.reset=25; assert(davis_radio_init(&config)); assert(!(reserved&(1ULL<<14)));
  davis_radio_stop(); clean();
  assert(!davis_radio_init(NULL)); config.reset=config.cs; assert(!davis_radio_init(&config)); clean();
  puts("radio lifecycle: GPIO ownership, partial failures, retries and cleanup passed");
  return 0;
}
