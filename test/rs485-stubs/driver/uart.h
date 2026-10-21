#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
typedef int uart_port_t;
typedef void *QueueHandle_t;
typedef struct {int baud_rate,data_bits,parity,stop_bits,flow_ctrl,source_clk;}uart_config_t;
typedef struct {int type;size_t size;bool timeout_flag;}uart_event_t;
#define UART_NUM_1 1
#define UART_DATA_8_BITS 8
#define UART_PARITY_DISABLE 0
#define UART_STOP_BITS_1 1
#define UART_HW_FLOWCTRL_DISABLE 0
#define UART_SCLK_DEFAULT 0
#define UART_PIN_NO_CHANGE -1
#define UART_FIFO_OVF 1
#define UART_BUFFER_FULL 2
#define UART_FRAME_ERR 3
#define UART_PARITY_ERR 4
#define UART_DATA 5
#define UART_BREAK 6
#define pdTRUE 1
int uart_driver_delete(int);
int uart_param_config(int,const uart_config_t*);
int uart_set_pin(int,int,int,int,int);
int uart_driver_install(int,int,int,int,QueueHandle_t*,int);
int uart_read_bytes(int,void*,size_t,int);
int xQueueReceive(QueueHandle_t,void*,int);
int xQueueReset(QueueHandle_t);
int uart_flush_input(int);
int uart_set_rx_full_threshold(int,int);
int uart_set_rx_timeout(int,uint8_t);
