import { DateTime } from 'luxon';
import { hash } from './store.js';
import { rainCoverageComplete } from './davis-iss.js';
import { optionalDatabaseMetrics } from '../shared/database-columns.js';

// Credentials never enter configuration, audit, the queue or the public copy.
export const databaseTargetHash = (target) =>
  hash(
    Object.fromEntries(
      Object.entries(target)
        .filter(
          ([key, value]) =>
            !['enabled', 'intervalSeconds', 'user', 'passwordEnv', 'transport'].includes(key) &&
            !(key === 'stationNameColumn' && value === null),
        )
        .map(([key, value]) => [
          key,
          key === 'columns'
            ? Object.fromEntries(
                Object.entries(value).filter(
                  ([metric, column]) => column !== null || !Object.hasOwn(optionalDatabaseMetrics, metric),
                ),
              )
            : value,
        ]),
    ),
  );
export function queueDatabaseObservation(store, station, body) {
  const setting = store.db.prepare('SELECT 1 FROM configuration WHERE scope=?').get(`database:${station.id}`);
  if (!setting || !body.sensorContact) return;
  const target = store.confirmedValue(`database:${station.id}`);
  if (!target.enabled) return;
  const observed = Date.parse(body.observedAt),
    targetHash = databaseTargetHash(target);
  const last = store.db
    .prepare('SELECT last_queued_at FROM database_delivery WHERE station_id=? AND target_hash=?')
    .get(station.id, targetHash);
  if (last && observed - last.last_queued_at < target.intervalSeconds * 1000) return;
  const date = DateTime.fromMillis(observed, { zone: 'Europe/Oslo' });
  const rain = store.db
    .prepare('SELECT * FROM rain_state WHERE station_id=? AND day=?')
    .get(station.id, date.toISODate());
  const extrema = Object.fromEntries(
    store.db
      .prepare('SELECT metric,minimum,maximum FROM rollups WHERE station_id=? AND period=?')
      .all(station.id, date.toISODate())
      .map((row) => [row.metric, { min: row.minimum, max: row.maximum }]),
  );
  const measurements = {
    ...body.measurements,
    ...body.derived,
    rainTodayMm: rainCoverageComplete(rain, station.rainCounterMmPerUnit, observed) ? rain.total_mm : null,
    temperatureMaxC: extrema.temperatureC?.max,
    temperatureMinC: extrema.temperatureC?.min,
    windGustMaxMs: extrema.windGustMs?.max,
    windMeanMaxMs: extrema.windMeanMs?.max,
    rainRateMaxMmH: extrema.rainRateMmH?.max,
    humidexMaxC: extrema.humidexC?.max,
    humidexMinC: extrema.humidexC?.min,
    windChillMaxC: extrema.windChillC?.max,
    windChillMinC: extrema.windChillC?.min,
    heatIndexMaxC: extrema.heatIndexC?.max,
    heatIndexMinC: extrema.heatIndexC?.min,
    localHour: date.hour,
    localMinute: date.minute,
    localSecond: date.second,
    localDay: date.day,
    localMonth: date.month,
    rainMonthMm: rainPeriodTotal(
      store,
      station,
      date.startOf('month').toISODate(),
      date.toISODate(),
      observed,
    ),
    rainYearMm: rainPeriodTotal(store, station, date.startOf('year').toISODate(), date.toISODate(), observed),
    rainYesterdayMm: rainPeriodTotal(
      store,
      station,
      date.minus({ days: 1 }).toISODate(),
      date.minus({ days: 1 }).toISODate(),
      observed,
    ),
    pressureTrendLastHourHpa: pressureChangeLastHour(store, station.id, observed),
  };
  const row = { station_id: target.stationKey, date: date.toISODate(), time: date.toFormat('HH:mm:ss') };
  if (target.stationNameColumn) row[target.stationNameColumn] = station.name;
  for (const [metric, column] of Object.entries(target.columns)) {
    if (!column) continue;
    let value = measurements[metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) value = null;
    if (
      value !== null &&
      ['windMeanMs', 'windGustMs', 'windGustMaxMs', 'windMeanMaxMs'].includes(metric) &&
      target.windUnit === 'kmh'
    )
      value *= 3.6;
    row[column] = value;
  }
  store.db
    .prepare('INSERT INTO database_outbox(station_id,target_hash,observed_at,row_json) VALUES (?,?,?,?)')
    .run(station.id, targetHash, observed, JSON.stringify(row));
  store.db
    .prepare(
      'INSERT INTO database_delivery(station_id,target_hash,last_queued_at) VALUES (?,?,?) ON CONFLICT(station_id,target_hash) DO UPDATE SET last_queued_at=excluded.last_queued_at',
    )
    .run(station.id, targetHash, observed);
}
function rainPeriodTotal(store, station, from, to, at) {
  const rows = store.db
    .prepare('SELECT * FROM rain_state WHERE station_id=? AND day>=? AND day<=?')
    .all(station.id, from, to);
  const expected = Math.round(DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days) + 1;
  if (
    rows.length !== expected ||
    rows.some((r) => !rainCoverageComplete(r, station.rainCounterMmPerUnit, at))
  )
    return null;
  return rows.reduce((sum, r) => sum + r.total_mm, 0);
}
function pressureChangeLastHour(store, stationId, at) {
  const rows = store.db
    .prepare(
      "SELECT observed_at AS at,json_extract(body,'$.measurements.pressureHpa') AS value FROM observations WHERE station_id=? AND observed_at>=? AND observed_at<=? AND json_extract(body,'$.sensorContact')=1 ORDER BY observed_at",
    )
    .all(stationId, at - 3600000, at)
    .filter((r) => typeof r.value === 'number');
  if (
    rows.length < 6 ||
    rows.at(-1).at - rows[0].at < 50 * 60000 ||
    rows.some((r, i) => i && r.at - rows[i - 1].at > 15 * 60000)
  )
    return null;
  const n = rows.length,
    meanX = rows.reduce((a, r) => a + (r.at - at) / 3600000, 0) / n,
    meanY = rows.reduce((a, r) => a + r.value, 0) / n;
  const numerator = rows.reduce((a, r) => a + ((r.at - at) / 3600000 - meanX) * (r.value - meanY), 0),
    denominator = rows.reduce((a, r) => a + ((r.at - at) / 3600000 - meanX) ** 2, 0);
  return denominator > 0 ? numerator / denominator : null;
}

export function databaseStatus(store) {
  return store.configurations('database:').map((item) => {
    const confirmed = store.confirmedValue(item.scope),
      targetHash = databaseTargetHash(confirmed);
    const pending = store.db
      .prepare('SELECT COUNT(*) AS count,MIN(observed_at) AS oldest FROM database_outbox WHERE station_id=?')
      .get(confirmed.stationId);
    const paused = store.db
      .prepare('SELECT COUNT(*) AS count FROM database_outbox WHERE station_id=? AND target_hash!=?')
      .get(confirmed.stationId, targetHash).count;
    const delivery = store.db
      .prepare(
        'SELECT last_delivered_at,last_error FROM database_delivery WHERE station_id=? AND target_hash=?',
      )
      .get(confirmed.stationId, targetHash);
    return {
      ...item,
      pending: pending.count,
      paused,
      oldestAt: pending.oldest,
      lastDeliveredAt: delivery?.last_delivered_at ?? null,
      lastError: delivery?.last_error ?? null,
      confirmedEnabled: confirmed.enabled,
    };
  });
}
