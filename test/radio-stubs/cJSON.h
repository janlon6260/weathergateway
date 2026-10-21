#pragma once
typedef struct cJSON { int unused; } cJSON;
cJSON *cJSON_AddObjectToObject(cJSON *parent, const char *key);
void cJSON_AddStringToObject(cJSON *parent, const char *key, const char *value);
void cJSON_AddNumberToObject(cJSON *parent, const char *key, double value);
