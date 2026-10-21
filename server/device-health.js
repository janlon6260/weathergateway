import { z } from 'zod';
import { id } from './schema.js';
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
export const deviceHealthSchema = z
  .object({
    online: z.boolean(),
    pending: counter,
    capacity: z.number().int().positive().optional(),
    dropped: counter,
    clockSynchronized: z.boolean().optional(),
    ipAddress: z.ipv4().optional(),
    wifiRssiDbm: z.number().int().min(-127).max(0).optional(),
    logStreaming: z.boolean().optional(),
    bootId: id.optional(),
    buildId: id.optional(),
    configurationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    firmwareVersion: z.string().max(64).optional(),
    idfVersion: z.string().max(80).optional(),
    uptimeMs: counter,
    heartbeatSequence: counter,
    freeHeapBytes: counter,
    minimumFreeHeapBytes: counter,
    largestFreeBlockBytes: counter,
    mainTaskStackFreeBytes: counter,
    flashSizeBytes: counter,
    resetReason: z
      .enum([
        'power_on',
        'software',
        'panic',
        'interrupt_watchdog',
        'task_watchdog',
        'watchdog',
        'deep_sleep',
        'brownout',
        'unknown',
      ])
      .optional(),
    wifiReconnects: counter,
    mqttReconnects: counter,
    packetsReceived: counter,
    lastIssPacketAgeMs: counter,
    bootCount: counter,
    cpuFrequencyMhz: counter,
    sensorContact: z.boolean().optional(),
    wifiChannel: z.number().int().min(1).max(14).optional(),
    security: z
      .object({
        chipRevision: z.number().int().nonnegative(),
        secureBoot: z.boolean(),
        flashEncryption: z.boolean(),
        nvsEncryption: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export function recordDeviceHealth(store, stationId, input, { retained = false } = {}) {
  id.parse(stationId);
  store.current(`station:${stationId}`);
  const body = deviceHealthSchema.parse(input);
  if (retained && body.online) return false;
  const previous = store.db.prepare('SELECT * FROM device_status WHERE station_id=?').get(stationId),
    old = previous ? JSON.parse(previous.payload) : {};
  if (
    body.online &&
    body.bootId &&
    body.bootId === old.bootId &&
    body.heartbeatSequence !== undefined &&
    body.heartbeatSequence <= (old.heartbeatSequence ?? -1)
  )
    return false;
  const value = {
    ...old,
    ...body,
    lastContactAt: body.online ? store.clock() : old.lastContactAt || previous?.received_at || null,
  };
  store.db
    .prepare('INSERT OR REPLACE INTO device_status VALUES (?,?,?)')
    .run(stationId, store.clock(), JSON.stringify(value));
  return true;
}
