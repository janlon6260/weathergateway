import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { id } from './schema.js';
import { Rejected } from './store.js';

export const deviceLogSchema = z
  .object({
    version: z.literal(1),
    stationId: id,
    sessionId: id,
    bootId: id,
    sequence: z.number().int().min(0).max(0xffffffff),
    uptimeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    level: z.enum(['error', 'warn', 'info', 'debug']),
    message: z.string().min(1).max(384),
    dropped: z.number().int().nonnegative().max(0xffffffff),
  })
  .strict();

// Strip terminal controls and mask recognizable secret fields before storage.
export function cleanDeviceLog(message) {
  return message
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/-----BEGIN[\s\S]*?(?:-----END[^\n]*|$)/g, '[sertifikat/nøkkel skjult]')
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+=*/gi, 'Bearer [skjult]')
    .replace(
      /((?:["']?)(?:password|passwd|private[_ -]?key|token|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1[skjult]',
    )
    .slice(0, 384);
}

export function logSession(store, stationId, input, actor) {
  id.parse(stationId);
  const station = store.confirmedValue(`station:${stationId}`);
  if (!station.enabled || station.model === 'Netatmo') throw new Rejected('Velg en aktiv ESP32-stasjon');
  const { seconds, sessionId } = z
    .object({
      seconds: z.number().int().min(0).max(300),
      sessionId: id.optional(),
    })
    .strict()
    .parse(input);
  return store.db
    .transaction(() => {
      const previous = store.db
        .prepare('SELECT * FROM device_log_sessions WHERE station_id=?')
        .get(stationId);
      if (sessionId && previous?.id !== sessionId)
        throw new Rejected('Loggøkten er erstattet. Start visningen på nytt.');
      const currentId = sessionId || randomUUID();
      if (!seconds && !sessionId) throw new Rejected('Oppgi loggøkten som skal stoppes', 400);
      const expiresAt = store.clock() + seconds * 1000;
      // Command delivery is short lived; an offline ESP must not start an old diagnostic session later.
      const commandId = store.queueCommand(
        stationId,
        'stream_logs',
        {
          logSessionId: currentId,
          logExpiresAt: new Date(expiresAt).toISOString(),
        },
        store.clock() + 30000,
      );
      store.db
        .prepare('INSERT OR REPLACE INTO device_log_sessions VALUES (?,?,?,?)')
        .run(stationId, currentId, expiresAt, commandId);
      if (!previous || previous.id !== currentId || previous.expires_at <= store.clock() || !seconds)
        store.audit(actor, seconds ? 'device_log_started' : 'device_log_stopped', {
          stationId,
          sessionId: currentId,
        });
      return { sessionId: currentId, expiresAt, commandId };
    })
    .immediate();
}

export function ingestDeviceLog(store, stationId, buffer, { retained = false } = {}) {
  if (retained || buffer.length > 2048) throw new Error('Ugyldig loggmelding');
  const body = deviceLogSchema.parse(JSON.parse(buffer.toString('utf8')));
  if (body.stationId !== id.parse(stationId)) throw new Error('Feil loggidentitet');
  const session = store.db.prepare('SELECT * FROM device_log_sessions WHERE station_id=?').get(stationId);
  if (!session || session.id !== body.sessionId || session.expires_at <= store.clock()) return false;
  if (!store.confirmedValue(`station:${stationId}`).enabled) return false;
  const safe = { ...body, message: cleanDeviceLog(body.message) };
  return store.db
    .transaction(() => {
      const result = store.db
        .prepare(
          'INSERT OR IGNORE INTO device_logs(station_id,boot_id,sequence,received_at,payload) VALUES (?,?,?,?,?)',
        )
        .run(stationId, body.bootId, body.sequence, store.clock(), JSON.stringify(safe));
      pruneDeviceLogs(store, stationId);
      return !!result.changes;
    })
    .immediate();
}

export function pruneDeviceLogs(store, stationId) {
  store.db.prepare('DELETE FROM device_logs WHERE received_at<?').run(store.clock() - 3600000);
  if (stationId)
    store.db
      .prepare(
        'DELETE FROM device_logs WHERE station_id=? AND id <= COALESCE((SELECT id FROM device_logs WHERE station_id=? ORDER BY id DESC LIMIT 1 OFFSET 1000),0)',
      )
      .run(stationId, stationId);
}

export function readDeviceLogs(store, stationId, after) {
  store.current(`station:${id.parse(stationId)}`);
  const cursor = z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .parse(after || 0);
  const rows = store.db
    .prepare(
      'SELECT id,received_at,payload FROM device_logs WHERE station_id=? AND id>? AND received_at>=? ORDER BY id LIMIT 200',
    )
    .all(stationId, cursor, store.clock() - 3600000);
  // Runtime log leases live locally; commands are authoritative in MariaDB.
  // A cross-store JOIN would route both tables to MariaDB and fail there.
  const lease = store.db.prepare('SELECT * FROM device_log_sessions WHERE station_id=?').get(stationId);
  const command = lease
    ? store.db.prepare('SELECT state FROM commands WHERE id=?').get(lease.command_id)
    : null;
  const session = lease
    ? { id: lease.id, expires_at: lease.expires_at, state: command?.state ?? null }
    : null;
  const status = store.db
    .prepare('SELECT received_at,payload FROM device_status WHERE station_id=?')
    .get(stationId);
  return {
    session: session || null,
    device: status
      ? {
          online: !!JSON.parse(status.payload).online && store.clock() - status.received_at < 60000,
          receivedAt: status.received_at,
        }
      : null,
    entries: rows.map((r) => ({ id: r.id, receivedAt: r.received_at, ...JSON.parse(r.payload) })),
    cursor: rows.at(-1)?.id ?? cursor,
  };
}
