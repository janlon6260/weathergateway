// Run the actual radio driver against a register/FIFO and timed ISS model.
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../firmware/main/davis_rfm69.c"

static int64_t clock_us;
static uint8_t registers[128], air_packet[10];
static bool payload, overrun;
const char *esp_err_to_name(esp_err_t error) { (void)error; return "test"; }
void host_log(const char *tag, const char *format, ...) { (void)tag; (void)format; }
int64_t esp_timer_get_time(void) { return clock_us; }
void esp_rom_delay_us(unsigned us) { clock_us += us; }
void vTaskDelay(int ms) { clock_us += ms * 1000; }
esp_err_t gpio_config(const gpio_config_t *config) { (void)config; return ESP_OK; }
esp_err_t gpio_reset_pin(int pin) { (void)pin; return ESP_OK; }
esp_err_t gpio_set_level(int pin, int level) { (void)pin; (void)level; return ESP_OK; }
int gpio_get_level(int pin) { (void)pin; return payload; }
esp_err_t spi_bus_initialize(spi_host_device_t bus, const spi_bus_config_t *config, int dma) { (void)bus; (void)config; (void)dma; return ESP_OK; }
esp_err_t spi_bus_add_device(spi_host_device_t bus, const spi_device_interface_config_t *config, spi_device_handle_t *out) { (void)bus; (void)config; *out=(void*)1; return ESP_OK; }
esp_err_t spi_bus_remove_device(spi_device_handle_t handle) { (void)handle; return ESP_OK; }
esp_err_t spi_bus_free(spi_host_device_t bus) { (void)bus; return ESP_OK; }
esp_err_t spi_device_polling_transmit(spi_device_handle_t handle, spi_transaction_t *t) {
  (void)handle; const uint8_t *tx=t->tx_buffer; uint8_t *rx=t->rx_buffer;
  if (t->length==88) {
    assert(payload); rx[0]=0;
    for(int i=0;i<10;i++) rx[i+1]=reverse_bits(air_packet[i]);
    payload=false; return ESP_OK;
  }
  assert(t->length==16);
  if(tx[0]&0x80) {
    registers[tx[0]&127]=tx[1];
    if(tx[0]==0xa8 && (tx[1]&0x10)) payload=overrun=false;
  } else {
    rx[0]=0;
    rx[1]=tx[0]==0x10?0x24:tx[0]==0x27?0x80:tx[0]==0x28?(payload?0x04:0)|(overrun?0x10:0):tx[0]==0x24?126:registers[tx[0]];
  }
  return ESP_OK;
}
static void packet_for(int id, int type) {
  memset(air_packet,0,sizeof(air_packet)); air_packet[0]=(type<<4)|(id-1); air_packet[1]=4;
  uint16_t crc=0;
  for(int i=0;i<6;i++) { crc^=(uint16_t)air_packet[i]<<8; for(int b=0;b<8;b++)crc=(crc<<1)^((crc&0x8000)?0x1021:0); }
  air_packet[6]=crc>>8;air_packet[7]=crc;air_packet[8]=air_packet[9]=255;
}
static void init(int id) {
  davis_radio_config_t config={.sck=18,.miso=19,.mosi=23,.cs=27,.reset=14,.dio0=26,.transmitter_id=id};
  payload=overrun=false; assert(davis_radio_init(&config));
}
static bool poll(void) { uint8_t packet[10]; int channel,rssi;return davis_radio_poll(clock_us/1000,packet,&channel,&rssi); }
static void receive(int id) { packet_for(id,8);payload=true;assert(poll()); }
int main(void) {
  clock_us=1000000;init(1);receive(1);
  // A FIFO error at the hop deadline must not suppress the hop indefinitely.
  int before=channel_index; clock_us=expected_at+160000; overrun=true;
  assert(!poll()); assert(channel_index==(before+1)%5);
  // A valid FIFO left unread during a network stall is old, not a fresh clock anchor.
  init(1);receive(1); int64_t first=received_at;
  clock_us=expected_at; packet_for(1,8); payload=true;
  clock_us+=8000000; assert(!poll()); assert(received_at==first);
  // All IDs, five channels and exact 62.5 ms periods, with a small clock mismatch.
  for(int id=1;id<=8;id++) {
    init(id); receive(id); int got=1, sent=1, air_channel=1;
    int64_t period=2500000LL+(id-1)*62500LL;
    int64_t next=clock_us+period+300; // transmitter clock is 120 ppm slower
    int64_t end=clock_us+1200000000LL;
    while(clock_us<end) {
      clock_us+=5000;
      if(clock_us>=next) {
        sent++;packet_for(id,8);
        if(channel_index==air_channel && registers[1]==0x10)payload=true;
        air_channel=(air_channel+1)%5;next+=period+300;
      }
      if(poll())got++;
    }
    assert(got==sent); assert(!davis_radio_failed(clock_us/1000));
  }
  // Wrong IDs / CRC failures never become weather; a short outage keeps phase.
  init(1);receive(1);clock_us=expected_at;packet_for(2,8);payload=true;assert(!poll());
  packet_for(1,8);air_packet[1]^=1;payload=true;assert(!poll());
  for(int n=0;n<12;n++){clock_us=expected_at+160000;assert(!poll());}
  assert(locked);clock_us=expected_at;receive(1);assert(locked);
  // Once phase has been abandoned, a returning ISS is reacquired within one cycle.
  for(int n=0;n<30;n++){clock_us+=3000000;assert(!poll());}
  int got=0, air_channel=3;int64_t next=clock_us+1700000,end=clock_us+16000000;
  while(clock_us<end) {
    clock_us+=5000;
    if(clock_us>=next){packet_for(1,8);if(channel_index==air_channel)payload=true;air_channel=(air_channel+1)%5;next+=2500000;}
    if(poll())got++;
  }
  assert(got>0);
  puts("radio reception: eight IDs x 20 minutes, delayed FIFO, errors, outages and reacquisition passed");
  return 0;
}
