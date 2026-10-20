// Power-safe bounded append log on the existing wear-levelled flash partition.
// CRC rejects torn records; ACK checkpoints are flushed before sector reuse.
// An application receipt, never the broker PUBACK, advances the durable cursor.
#include <string.h>
#include <stdlib.h>
#include <stddef.h>
#include "esp_partition.h"
#include "wear_levelling.h"
#include "esp_rom_crc.h"
#include "esp_log.h"
#include "wg_spool.h"
#define SLOT_BYTES 512
#define SECTOR_BYTES 4096
#define MAGIC 0x57475333
typedef struct {
  uint32_t magic, crc;
  wg_spool_record_t record;
  uint8_t padding[SLOT_BYTES - 8 - sizeof(wg_spool_record_t)];
} slot_t;
_Static_assert(sizeof(slot_t) == SLOT_BYTES, "Spool record must fill a flash slot");
static wl_handle_t flash;
static nvs_handle_t state;
static uint32_t slots;
static uint64_t highest, acknowledged, checkpoint, dropped;
static uint32_t crc(const slot_t *slot) { return esp_rom_crc32_le(0,(const uint8_t *)&slot->record,SLOT_BYTES-8); }
static bool valid(const slot_t *slot) { return slot->magic == MAGIC && slot->record.number > 0 && slot->record.packet_size <= 99 && slot->record.boot_id[36] == 0 && slot->record.configuration_hash[64] == 0 && slot->record.release_id[36] == 0 && slot->crc == crc(slot); }
static void save_ack(void) { ESP_ERROR_CHECK(nvs_set_u64(state,"spool_ack",acknowledged)); ESP_ERROR_CHECK(nvs_set_u64(state,"spool_dropped",dropped)); ESP_ERROR_CHECK(nvs_commit(state)); checkpoint = acknowledged; }
void wg_spool_init(nvs_handle_t nvs) {
  highest = acknowledged = checkpoint = dropped = 0;
  state = nvs; const esp_partition_t *partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,ESP_PARTITION_SUBTYPE_ANY,"storage");
  if (!partition) abort();
  ESP_ERROR_CHECK(wl_mount(partition,&flash));
  if (wl_sector_size(flash) != SECTOR_BYTES) abort();
  slots = (wl_size(flash) / SECTOR_BYTES) * (SECTOR_BYTES / SLOT_BYTES);
  if (slots < 16) abort();
  esp_err_t loaded = nvs_get_u64(state,"spool_ack",&acknowledged); if (loaded != ESP_OK && loaded != ESP_ERR_NVS_NOT_FOUND) abort();
  (void)nvs_get_u64(state,"spool_dropped",&dropped); checkpoint = acknowledged; highest = acknowledged;
  slot_t slot;
  for (uint32_t i = 0; i < slots; i++) { ESP_ERROR_CHECK(wl_read(flash,i*SLOT_BYTES,&slot,sizeof(slot))); if (valid(&slot) && slot.record.number > highest) highest = slot.record.number; }
}
bool wg_spool_append(wg_spool_record_t *record) {
  if (highest - acknowledged >= wg_spool_capacity()) { dropped++; if (dropped % 16 == 1) save_ack(); return false; }
  const uint64_t number = highest + 1; const uint32_t index = (number-1)%slots, offset = index*SLOT_BYTES, sector = (offset/SECTOR_BYTES)*SECTOR_BYTES;
  slot_t old; ESP_ERROR_CHECK(wl_read(flash,offset,&old,sizeof(old)));
  bool erased = true; for (size_t i = 0; i < sizeof(old); i++) if (((uint8_t *)&old)[i] != 0xff) { erased = false; break; }
  if (!erased || index % (SECTOR_BYTES/SLOT_BYTES) == 0) {
    for (uint32_t p = sector; p < sector+SECTOR_BYTES; p += SLOT_BYTES) {
      ESP_ERROR_CHECK(wl_read(flash,p,&old,sizeof(old)));
      if (valid(&old) && old.record.number > acknowledged) { dropped++; if (dropped % 16 == 1) save_ack(); return false; }
    }
    save_ack(); ESP_ERROR_CHECK(wl_erase_range(flash,sector,SECTOR_BYTES));
  }
  slot_t slot; memset(&slot,0,sizeof(slot)); record->number = number; slot.magic = MAGIC; slot.record = *record; slot.crc = crc(&slot);
  ESP_ERROR_CHECK(wl_write(flash,offset,&slot,sizeof(slot))); highest = number; return true;
}
bool wg_spool_peek(wg_spool_record_t *record) {
  slot_t slot;
  while (acknowledged < highest) {
    ESP_ERROR_CHECK(wl_read(flash,((acknowledged)%slots)*SLOT_BYTES,&slot,sizeof(slot)));
    if (valid(&slot) && slot.record.number == acknowledged+1) { *record = slot.record; return true; }
    acknowledged++; dropped++; save_ack();
  }
  return false;
}
void wg_spool_ack(uint64_t number) { if (number != acknowledged+1 || number > highest) return; acknowledged = number; if (acknowledged-checkpoint >= 16 || acknowledged == highest) save_ack(); }
uint64_t wg_spool_pending(void) { return highest-acknowledged; }
uint64_t wg_spool_dropped(void) { return dropped; }
// Reserve a sector minus one slot so a partially acknowledged tail can never
// block reuse while the reported queue still has available capacity.
uint32_t wg_spool_capacity(void) { return slots-(SECTOR_BYTES/SLOT_BYTES-1); }
