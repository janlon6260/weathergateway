#pragma once
void test_rs485_log(const char*,...);
#define ESP_LOGI(tag,...) test_rs485_log(__VA_ARGS__)
