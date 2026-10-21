import { crcCcitt } from './davis.js';
import { windPresentation } from '../shared/wind.js';

const protocols = new Set(['davis-iss', 'davis-iss-rs485', 'davis-loop']);
const numericFields = (value) =>
  Object.fromEntries(
    Object.entries(value || {}).filter(
      ([key, v]) =>
        /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(key) &&
        (v === null || (typeof v === 'number' && Number.isFinite(v))),
    ),
  );
export function packetView(body, row, station, status = 'accepted') {
  const source = body.source;
  if (
    !protocols.has(source?.protocol) ||
    typeof source.packet !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.packet) ||
    !source.packet.length ||
    source.packet.length > 344
  )
    return null;
  const bytes = Buffer.from(source.packet, 'base64');
  if (bytes.length > 256) return null;
  const iss = source.protocol.startsWith('davis-iss');
  const accepted = status === 'accepted';
  const measurements = accepted ? numericFields(body.measurements) : {};
  const rawMeasurements = accepted ? numericFields(body.rawMeasurements) : {};
  const derived = accepted ? numericFields(body.derived) : {};
  const metrics = new Set([
    ...Object.keys(measurements),
    ...Object.keys(rawMeasurements),
    ...Object.keys(derived),
  ]);
  return {
    id: `${row.station_id}:${row.boot_id}:${row.sequence}:${status}`,
    stationId: station.id,
    stationName: station.name,
    receivedAt: new Date(row.received_at).toISOString(),
    observedAt: Number.isFinite(Date.parse(body.observedAt)) ? body.observedAt : null,
    sequence: row.sequence,
    status,
    reason: status === 'rejected' ? row.reason : null,
    protocol: source.protocol,
    channel:
      Number.isInteger(source.channel) && source.channel >= 0 && source.channel < 5
        ? source.channel + 1
        : null,
    rssiDbm: Number.isFinite(source.rssiDbm) ? source.rssiDbm : null,
    hex: bytes.toString('hex').toUpperCase().match(/.{2}/g)?.join(' ') || '',
    bytes: [...bytes],
    checksum:
      source.protocol === 'davis-iss-rs485'
        ? 'none'
        : (
              source.protocol === 'davis-iss'
                ? bytes.length === 10 && crcCcitt(bytes.subarray(0, 8)) === 0
                : bytes.length === 99 && crcCcitt(bytes) === 0
            )
          ? 'valid'
          : 'invalid',
    ...(iss && bytes.length >= 3
      ? {
          type: bytes[0] >> 4,
          transmitterId: (bytes[0] & 7) + 1,
          batteryLow: Boolean(bytes[0] & 8),
          rawWindSpeedMph: bytes[1],
          rawWindDirectionByte: bytes[2],
        }
      : {}),
    calibrationRevision: Number.isInteger(body.calibrationRevision) ? body.calibrationRevision : null,
    rawMeasurements,
    measurements,
    derived,
    freshFields:
      accepted && Array.isArray(body.freshFields) ? body.freshFields.filter((key) => metrics.has(key)) : null,
    measurementTimes: accepted
      ? Object.fromEntries(
          Object.entries(body.measurementTimes || {}).filter(
            ([key, at]) => metrics.has(key) && typeof at === 'string' && Number.isFinite(Date.parse(at)),
          ),
        )
      : {},
    rainCounterTips:
      accepted &&
      Number.isInteger(body.iss?.rainCounterTips) &&
      body.iss.rainCounterTips >= 0 &&
      body.iss.rainCounterTips < 128
        ? body.iss.rainCounterTips
        : null,
    wind: windPresentation(measurements.windSpeedMs, measurements.windDirectionDeg),
  };
}
export function recentPackets(store, stationId) {
  const now = store.clock(),
    since = now - 60000,
    limit = 500;
  const stations = new Map(
    store.stationList().map((item) => {
      const station = store.confirmedValue(item.scope);
      return [station.id, station];
    }),
  );
  const filter = stationId ? ' AND station_id=?' : '';
  const args = stationId ? [since, now, stationId] : [since, now];
  const packets = [];
  for (const [table, column, status] of [
    ['observations', 'body', 'accepted'],
    ['telemetry_rejections', 'payload', 'rejected'],
  ]) {
    const rows = store.db
      .prepare(
        `SELECT * FROM ${table}
      WHERE received_at>? AND received_at<=?${filter}
        AND CASE WHEN json_valid(${column}) THEN json_extract(${column},'$.source.packet') END IS NOT NULL
      ORDER BY received_at DESC,station_id,sequence DESC LIMIT ?`,
      )
      .all(...args, limit + 1);
    for (const row of rows) {
      const station = stations.get(row.station_id);
      if (!station) continue;
      try {
        const packet = packetView(JSON.parse(row[column]), row, station, status);
        if (packet) packets.push(packet);
      } catch {
        /* A malformed diagnostic must not break the live view. */
      }
    }
  }
  packets.sort(
    (a, b) =>
      Date.parse(b.receivedAt) - Date.parse(a.receivedAt) ||
      b.sequence - a.sequence ||
      a.id.localeCompare(b.id),
  );
  return {
    now,
    windowSeconds: 60,
    since: new Date(since).toISOString(),
    truncated: packets.length > limit,
    limit,
    packets: packets.slice(0, limit),
  };
}
