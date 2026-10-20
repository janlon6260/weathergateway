#pragma once
#include "esp_partition.h"
typedef int wl_handle_t;
esp_err_t wl_mount(const esp_partition_t *,wl_handle_t *);
size_t wl_size(wl_handle_t);
size_t wl_sector_size(wl_handle_t);
esp_err_t wl_read(wl_handle_t,size_t,void *,size_t);
esp_err_t wl_write(wl_handle_t,size_t,const void *,size_t);
esp_err_t wl_erase_range(wl_handle_t,size_t,size_t);
