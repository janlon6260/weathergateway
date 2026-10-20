#pragma once
#include "esp_err.h"
typedef int spi_host_device_t;
typedef void *spi_device_handle_t;
#define SPI2_HOST 2
#define SPI_DMA_DISABLED 0
typedef struct { int mosi_io_num,miso_io_num,sclk_io_num,quadwp_io_num,quadhd_io_num,max_transfer_sz; } spi_bus_config_t;
typedef struct { int clock_speed_hz,mode,spics_io_num,queue_size; } spi_device_interface_config_t;
typedef struct { int length; const void *tx_buffer; void *rx_buffer; } spi_transaction_t;
esp_err_t spi_device_polling_transmit(spi_device_handle_t handle, spi_transaction_t *transaction);
esp_err_t spi_bus_initialize(spi_host_device_t host, const spi_bus_config_t *config, int dma);
esp_err_t spi_bus_add_device(spi_host_device_t host, const spi_device_interface_config_t *config, spi_device_handle_t *out);
esp_err_t spi_bus_remove_device(spi_device_handle_t handle);
esp_err_t spi_bus_free(spi_host_device_t host);
