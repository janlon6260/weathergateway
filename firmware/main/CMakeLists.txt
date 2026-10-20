if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/provisioning.h")
  message(FATAL_ERROR "Generate provisioning.h and device certificates with scripts/provision-firmware.js first")
endif()
idf_component_register(SRCS "main.c" "davis_uart.c" "davis_rfm69.c" "wg_ota.c" "wg_spool.c" "wg_credentials.c" "wg_logs.c" INCLUDE_DIRS "." REQUIRES esp_wifi esp_event esp_netif nvs_flash mqtt cjson mbedtls esp_driver_uart esp_driver_spi esp_driver_gpio app_update esp_timer wear_levelling spi_flash esp_rom bootloader_support esp_hw_support efuse EMBED_TXTFILES "ca.pem" "device.pem" "device.key")
