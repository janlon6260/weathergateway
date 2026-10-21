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
    mqttInputDropped: counter,
    packetsReceived: counter,
    lastIssPacketAgeMs: counter,
    bootCount: counter,
    cpuFrequencyMhz: counter,
    sensorContact: z.boolean().optional(),
    wifiChannel: z.number().int().min(1).max(14).optional(),
    radio: z
      .object({
        state: z.enum(['unavailable', 'scanning', 'tracking']),
        transmitterId: z.number().int().min(1).max(8),
        channel: z.number().int().min(1).max(5),
        lastReceivedChannel: z.number().int().min(1).max(5).optional(),
        rssiDbm: z.number().int().min(-127).max(0).optional(),
        packetsReceived: counter,
        crcErrors: counter,
        foreignPackets: counter,
        repeaterPackets: counter,
        fifoOverruns: counter,
        missedPackets: counter,
        resyncs: counter,
        spiErrors: counter,
        stalePackets: counter,
        maxPollGapMs: counter,
        queuedPackets: counter,
        queueDropped: counter,
        lastPacketAgeMs: counter,
        rssiThresholdDbm: z.number().int().min(-120).max(-40).optional(),
        backgroundRssiDbm: z.number().int().min(-127).max(0).optional(),
        afcHz: z.number().int().min(-2000000).max(2000000).optional(),
        signalTimeouts: counter,
        pllTimeouts: counter,
        lastRejected: z
          .object({
            reason: z.enum(['crc', 'repeater', 'transmitter-id']).optional(),
            packetHex: z.string().regex(/^[a-f0-9]{20}$/),
            channel: z.number().int().min(1).max(5),
            rssiDbm: z.number().int().min(-127).max(0),
            afcHz: z.number().int().min(-2000000).max(2000000),
            ageMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    rs485: z
      .object({
        protocol: z.literal('davis-iss-rs485-v1'),
        checksum: z.literal('none'),
        baud: z.literal(4800),
        bytesReceived: counter,
        uartErrors: counter,
        overflows: counter,
        framesReceived: counter,
        invalidFrames: counter,
      })
      .strict()
      .optional(),
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
  // A live profile change must not keep diagnostics from the previous receiver.
  // LWT still preserves the last reported health for troubleshooting.
  if (body.online && body.radio) delete value.rs485;
  if (body.online && body.rs485) delete value.radio;
  store.db
    .prepare('INSERT OR REPLACE INTO device_status VALUES (?,?,?)')
    .run(stationId, store.clock(), JSON.stringify(value));
  return true;
}
