// Runs the actual firmware implementation against strict flash/NVS doubles.
// The doubles enforce flash's 1->0 write rule and cut power at chosen writes.
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>
#include "wear_levelling.h"
#include "esp_rom_crc.h"
#ifdef __TINYC__
#define _Static_assert(condition,message) typedef char host_static_assert[(condition)?1:-1]
#endif
#include "../../firmware/main/wg_spool.c"
static unsigned char disk[8192];
static uint64_t durable_ack, durable_drop, staging_ack, staging_drop;
static int cut_write = -1, cut_commit, cut_erase;
static jmp_buf power_failure;
static esp_partition_t part;
const esp_partition_t *esp_partition_find_first(int type,int subtype,const char *label) {(void)type;(void)subtype;assert(!strcmp(label,"storage"));return &part;}
esp_err_t wl_mount(const esp_partition_t *p,wl_handle_t *h) {(void)p;*h=1;return ESP_OK;}
size_t wl_size(wl_handle_t h) {(void)h;return sizeof(disk);}
size_t wl_sector_size(wl_handle_t h) {(void)h;return 4096;}
esp_err_t wl_read(wl_handle_t h,size_t offset,void *out,size_t length) {(void)h;assert(offset+length<=sizeof(disk));memcpy(out,disk+offset,length);return ESP_OK;}
esp_err_t wl_write(wl_handle_t h,size_t offset,const void *input,size_t length) {
  (void)h; const unsigned char *bytes = input; assert(offset+length<=sizeof(disk));
  for(size_t i=0;i<length;i++) {if(cut_write==0) longjmp(power_failure,1);assert((disk[offset+i]&bytes[i])==bytes[i]);disk[offset+i]=bytes[i];if(cut_write>0)cut_write--;}
  return ESP_OK;
}
esp_err_t wl_erase_range(wl_handle_t h,size_t offset,size_t length) {(void)h;assert(offset%4096==0 && length==4096);memset(disk+offset,255,length);if(cut_erase)longjmp(power_failure,1);return ESP_OK;}
esp_err_t nvs_get_u64(nvs_handle_t h,const char *key,uint64_t *out) {(void)h;*out=!strcmp(key,"spool_ack")?durable_ack:durable_drop;return ESP_OK;}
esp_err_t nvs_set_u64(nvs_handle_t h,const char *key,uint64_t value) {(void)h;if(!strcmp(key,"spool_ack"))staging_ack=value;else staging_drop=value;return ESP_OK;}
esp_err_t nvs_commit(nvs_handle_t h) {(void)h;if(cut_commit)longjmp(power_failure,1);durable_ack=staging_ack;durable_drop=staging_drop;return ESP_OK;}
uint32_t esp_rom_crc32_le(uint32_t seed,const uint8_t *data,size_t length) {uint32_t c=~seed;for(size_t i=0;i<length;i++){c^=data[i];for(int bit=0;bit<8;bit++)c=(c>>1)^(0xedb88320u&-(c&1));}return ~c;}
static void reset(void) {memset(disk,255,sizeof(disk));durable_ack=durable_drop=staging_ack=staging_drop=0;cut_write=-1;cut_commit=cut_erase=0;wg_spool_init(1);}
static wg_spool_record_t sample(unsigned sequence) {wg_spool_record_t r;memset(&r,0,sizeof(r));snprintf(r.boot_id,sizeof(r.boot_id),"402500fa-a03b-4dcf-af73-11109f9b8329");memset(r.configuration_hash,'a',64);r.sequence=sequence;r.packet_size=10;r.packet[0]=sequence;return r;}
static void ack_next(unsigned expected) {wg_spool_record_t r;assert(wg_spool_peek(&r));assert(r.sequence==expected);wg_spool_ack(r.number);}
static void replay_and_capacity(void) {
  reset();assert(wg_spool_capacity()==9);
  for(unsigned i=1;i<=9;i++){wg_spool_record_t r=sample(i);assert(wg_spool_append(&r));}
  wg_spool_record_t r=sample(10);assert(!wg_spool_append(&r));assert(wg_spool_dropped()==1);
  for(unsigned i=1;i<=4;i++)ack_next(i);
  wg_spool_init(1); // uncheckpointed receipts may replay; no observation disappears
  for(unsigned i=1;i<=9;i++)ack_next(i);
  assert(wg_spool_pending()==0);wg_spool_init(1);assert(wg_spool_pending()==0);
}
static void repeated_wraps(void) {
  reset();for(unsigned first=1;first<=400;first+=8){for(unsigned i=first;i<first+8;i++){wg_spool_record_t r=sample(i);assert(wg_spool_append(&r));}for(unsigned i=first;i<first+8;i++)ack_next(i);wg_spool_init(1);assert(wg_spool_pending()==0);}
}
static void torn_append(void) {
  for(int cut=0;cut<512;cut+=7){reset();wg_spool_record_t first=sample(1);assert(wg_spool_append(&first));
    if(setjmp(power_failure)==0){cut_write=cut;wg_spool_record_t second=sample(2);wg_spool_append(&second);assert(!"Expected power cut");}
    cut_write=-1;wg_spool_init(1);ack_next(1);wg_spool_record_t second=sample(2);assert(wg_spool_append(&second));ack_next(2);assert(wg_spool_pending()==0);
  }
}
static void cut_checkpoint(void) {
  reset();wg_spool_record_t r=sample(1);assert(wg_spool_append(&r));
  if(setjmp(power_failure)==0){cut_commit=1;ack_next(1);assert(!"Expected checkpoint cut");}
  cut_commit=0;staging_ack=durable_ack;staging_drop=durable_drop;wg_spool_init(1);ack_next(1);assert(wg_spool_pending()==0);
}
static void cut_sector_reuse(void) {
  reset();for(unsigned i=1;i<=9;i++){wg_spool_record_t r=sample(i);assert(wg_spool_append(&r));}for(unsigned i=1;i<=8;i++)ack_next(i);
  for(unsigned i=10;i<=16;i++){wg_spool_record_t r=sample(i);assert(wg_spool_append(&r));}
  if(setjmp(power_failure)==0){cut_erase=1;wg_spool_record_t r=sample(17);wg_spool_append(&r);assert(!"Expected erase power cut");}
  cut_erase=0;wg_spool_init(1);wg_spool_record_t r=sample(17);assert(wg_spool_append(&r));for(unsigned i=9;i<=17;i++)ack_next(i);assert(wg_spool_pending()==0);
}
int main(void) {replay_and_capacity();repeated_wraps();torn_append();cut_checkpoint();cut_sector_reuse();puts("PASS: actual spool C: capacity, 400 records with wraps, 74 torn-write positions, checkpoint/sector-reuse power cuts");return 0;}
