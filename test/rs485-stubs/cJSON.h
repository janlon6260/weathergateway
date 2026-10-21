#pragma once
typedef struct cJSON { int unused; } cJSON;
cJSON *cJSON_AddObjectToObject(cJSON*,const char*);
void cJSON_AddBoolToObject(cJSON*,const char*,int);
void cJSON_AddNumberToObject(cJSON*,const char*,double);
