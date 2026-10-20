import { DateTime } from 'luxon';
import { meteorologyDefaults } from './schema.js';
import {
  saturationVapourPressure,
  degreeDays,
  growingDegreeDays,
  referenceEt,
  climateVersion,
} from './climate.js';

export const meteorology = (station) => ({ ...meteorologyDefaults, ...station.meteorology });
const numeric = (v) => typeof v === 'number' && Number.isFinite(v);
const hourMs = 3600000;
const windCache = new WeakMap();
const merge = (target, delta, factor) => {
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value === 'number') target[key] = (target[key] || 0) + value * factor;
    else merge((target[key] ||= {}), value, factor);
  }
  return target;
};
function segmentValues(body, settings) {
  if (!body.sensorContact) return {};
  const m = body.measurements,
    result = {};
  for (const metric of ['temperatureC', 'humidityPct', 'stationPressureHpa', 'windSpeedMs', 'solarWm2'])
    if (numeric(m[metric])) result[metric] = m[metric];
  if (numeric(m.temperatureC) && numeric(m.humidityPct))
    result.actualVapourKpa = (saturationVapourPressure(m.temperatureC) * m.humidityPct) / 100;
  if (numeric(m.solarWm2)) result.sunshineProxy = Number(m.solarWm2 >= settings.sunshineThresholdWm2);
  if (numeric(m.windSpeedMs)) {
    if (m.windSpeedMs < 0.3) result.calm = 1;
    else if (numeric(m.windDirectionDeg)) {
      const bearing = ((m.windDirectionDeg % 360) * Math.PI) / 180;
      result.windX = m.windSpeedMs * Math.sin(bearing);
      result.windY = m.windSpeedMs * Math.cos(bearing);
      result[`rose${Math.floor(((m.windDirectionDeg % 360) + 11.25) / 22.5) % 16}`] = 1;
    }
  }
  return result;
}
function changeBins(store, stationId, segment, factor) {
  const values = JSON.parse(segment.payload);
  for (let start = segment.start_at; start < segment.end_at;) {
    const hour = Math.floor(start / hourMs) * hourMs,
      end = Math.min(segment.end_at, hour + hourMs);
    const seconds = (end - start) / 1000;
    const old = store.db
      .prepare('SELECT payload FROM weather_bins WHERE station_id=? AND hour=?')
      .get(stationId, hour);
    const bin = old ? JSON.parse(old.payload) : {};
    for (const [metric, value] of Object.entries(values))
      merge((bin[metric] ||= {}), { total: value * seconds, seconds }, factor);
    store.db
      .prepare('INSERT OR REPLACE INTO weather_bins VALUES (?,?,?)')
      .run(stationId, hour, JSON.stringify(bin));
    start = end;
  }
}
function connectSamples(store, station, from, to) {
  if (!from) return;
  const start = from.observed_at,
    old = store.db
      .prepare('SELECT * FROM weather_segments WHERE station_id=? AND start_at=?')
      .get(station.id, start);
  if (old) {
    changeBins(store, station.id, old, -1);
    store.db.prepare('DELETE FROM weather_segments WHERE station_id=? AND start_at=?').run(station.id, start);
  }
  const settings = meteorology(station),
    duration = to ? to.observed_at - start : 0;
  if (duration <= 0 || duration > settings.maximumGapSeconds * 1000) return;
  const body = JSON.parse(from.body),
    next = JSON.parse(to.body);
  if (body.bootId !== next.bootId || body.calibrationRevision !== next.calibrationRevision) return;
  const segment = {
    start_at: start,
    end_at: to.observed_at,
    payload: JSON.stringify(segmentValues(body, settings)),
  };
  store.db
    .prepare('INSERT INTO weather_segments VALUES (?,?,?,?)')
    .run(station.id, start, segment.end_at, segment.payload);
  changeBins(store, station.id, segment, 1);
}

// Runs within the observation transaction. Late samples replace both adjacent
// intervals and subtract their previous contribution, without double counting.
export function addTemporalObservation(store, station, body) {
  windCache.delete(store);
  const at = Date.parse(body.observedAt);
  const current = store.db
    .prepare(
      'SELECT observed_at,body FROM observations WHERE station_id=? AND observed_at=? ORDER BY rowid LIMIT 1',
    )
    .get(station.id, at);
  const previous = store.db
    .prepare(
      'SELECT observed_at,body FROM observations WHERE station_id=? AND observed_at<? ORDER BY observed_at DESC,rowid LIMIT 1',
    )
    .get(station.id, at);
  const next = store.db
    .prepare(
      'SELECT observed_at,body FROM observations WHERE station_id=? AND observed_at>? ORDER BY observed_at,rowid LIMIT 1',
    )
    .get(station.id, at);
  connectSamples(store, station, previous, current);
  connectSamples(store, station, current, next);
}

function windIntegral(segments, start, end) {
  let total = 0,
    seconds = 0,
    x = 0,
    y = 0,
    directionalSeconds = 0;
  for (const s of segments) {
    const span = (Math.min(end, s.end_at) - Math.max(start, s.start_at)) / 1000;
    if (span <= 0 || !numeric(s.values.windSpeedMs)) continue;
    total += s.values.windSpeedMs * span;
    seconds += span;
    if (numeric(s.values.windX)) {
      x += s.values.windX * span;
      y += s.values.windY * span;
      directionalSeconds += span;
    }
  }
  return {
    total,
    seconds,
    direction:
      directionalSeconds && Math.hypot(x, y) > 1e-8 ? ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 : null,
  };
}
export function rollingWind(store, station, at = store.clock()) {
  let cache = windCache.get(store);
  if (!cache) windCache.set(store, (cache = new Map()));
  const key = `${station.id}:${at}:${JSON.stringify(station.meteorology)}`;
  if (cache.has(key)) return cache.get(key);
  const settings = meteorology(station),
    duration = settings.windWindowSeconds * 1000,
    start = at - duration;
  const segments = store.db
    .prepare(
      'SELECT * FROM weather_segments WHERE station_id=? AND start_at<? AND end_at>? ORDER BY start_at',
    )
    .all(station.id, at, start - 3000)
    .map((s) => ({ ...s, values: JSON.parse(s.payload) }));
  const integral = windIntegral(segments, start, at),
    coverage = Math.min(1, integral.seconds / settings.windWindowSeconds);
  const candidates = new Set([at]);
  for (const s of segments) {
    if (s.end_at >= start + 3000) candidates.add(Math.min(at, s.end_at));
    if (s.start_at + 3000 <= at && s.start_at + 3000 >= start + 3000) candidates.add(s.start_at + 3000);
  }
  let gustMs = null,
    gustAt = null;
  for (const end of candidates) {
    if (end - 3000 < start) continue;
    const value = windIntegral(segments, end - 3000, end);
    if (
      value.seconds >= 3 * settings.minimumCoverage &&
      (gustMs === null || value.total / value.seconds > gustMs)
    ) {
      gustMs = value.total / value.seconds;
      gustAt = end;
    }
  }
  const result = {
    method: 'time-weighted-hold-3s-gust-v1',
    windowSeconds: settings.windWindowSeconds,
    coverage,
    meanMs: coverage >= settings.minimumCoverage ? integral.total / integral.seconds : null,
    directionDeg: coverage >= settings.minimumCoverage ? integral.direction : null,
    gustMs,
    gustAt: gustAt === null ? null : new Date(gustAt).toISOString(),
  };
  cache.set(key, result);
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return result;
}
export function invalidateWeatherCache(store) {
  windCache.delete(store);
}

export function climateDay(store, station, date) {
  const start = DateTime.fromISO(date, { zone: 'Europe/Oslo' }).startOf('day');
  if (!start.isValid || start.toISODate() !== date) throw new Error('Ugyldig klimadato');
  const end = start.plus({ days: 1 }),
    seconds = (end.toMillis() - start.toMillis()) / 1000;
  const effectiveEnd = Math.min(end.toMillis(), Math.max(start.toMillis(), store.clock())),
    elapsedSeconds = (effectiveEnd - start.toMillis()) / 1000;
  const fullHourEnd = Math.floor(effectiveEnd / hourMs) * hourMs;
  const rows = store.db
    .prepare('SELECT payload FROM weather_bins WHERE station_id=? AND hour>=? AND hour<?')
    .all(station.id, start.toMillis(), fullHourEnd);
  const values = {};
  for (const row of rows) merge(values, JSON.parse(row.payload), 1);
  if (effectiveEnd > fullHourEnd && fullHourEnd >= start.toMillis()) {
    const partial = store.db
      .prepare('SELECT * FROM weather_segments WHERE station_id=? AND start_at<? AND end_at>?')
      .all(station.id, effectiveEnd, fullHourEnd);
    for (const segment of partial) {
      const seconds =
        (Math.min(effectiveEnd, segment.end_at) - Math.max(fullHourEnd, segment.start_at)) / 1000;
      if (seconds <= 0) continue;
      for (const [metric, value] of Object.entries(JSON.parse(segment.payload)))
        merge(values, { [metric]: { total: value * seconds, seconds } }, 1);
    }
  }
  const settings = meteorology(station),
    coverage = {};
  for (const [metric, value] of Object.entries(values))
    coverage[metric] = elapsedSeconds > 0 ? Math.min(1, Math.max(0, value.seconds / elapsedSeconds)) : 0;
  const mean = (metric) =>
    coverage[metric] >= settings.minimumCoverage ? values[metric].total / values[metric].seconds : null;
  const extremes = store.db
    .prepare("SELECT minimum,maximum FROM rollups WHERE station_id=? AND period=? AND metric='temperatureC'")
    .get(station.id, date);
  const complete = end.toMillis() <= store.clock();
  const degree =
    complete && numeric(mean('temperatureC')) && extremes
      ? degreeDays(extremes.minimum, extremes.maximum, settings.heatingBaseC)
      : null;
  const windSeconds = values.windSpeedMs?.seconds || 0;
  const rose = Array.from({ length: 16 }, (_, i) => ({
    bearing: i * 22.5,
    seconds: Math.max(0, values[`rose${i}`]?.total || 0),
    percent: windSeconds ? (Math.max(0, values[`rose${i}`]?.total || 0) * 100) / windSeconds : null,
  }));
  const etInputs = {
    minC: extremes?.minimum,
    maxC: extremes?.maximum,
    actualVapourKpa: mean('actualVapourKpa'),
    windMs: mean('windSpeedMs'),
    windHeightM: settings.windHeightM,
    solarMj: coverage.solarWm2 >= settings.minimumCoverage ? values.solarWm2.total / 1e6 : null,
    stationPressureHpa: mean('stationPressureHpa'),
    latitude: station.latitude,
    elevationM: station.elevationM,
    dayOfYear: start.ordinal,
  };
  return {
    date,
    timezone: 'Europe/Oslo',
    method: climateVersion,
    complete,
    expectedSeconds: seconds,
    elapsedSeconds,
    coverage,
    means: Object.fromEntries(
      ['temperatureC', 'humidityPct', 'windSpeedMs', 'stationPressureHpa'].map((metric) => [
        metric,
        mean(metric),
      ]),
    ),
    windRunObservedKm: windSeconds ? values.windSpeedMs.total / 1000 : null,
    windRunKm: coverage.windSpeedMs >= settings.minimumCoverage ? values.windSpeedMs.total / 1000 : null,
    windRose: rose,
    calmPercent: windSeconds ? ((values.calm?.total || 0) * 100) / windSeconds : null,
    solarEnergyMj: etInputs.solarMj,
    sunshineProxyHours:
      coverage.solarWm2 >= settings.minimumCoverage ? (values.sunshineProxy?.total || 0) / 3600 : null,
    sunshineMethod: 'global-radiation-threshold-proxy',
    heatingDegreeDays: degree?.heating ?? null,
    coolingDegreeDays: degree?.cooling ?? null,
    growingDegreeDays: degree
      ? growingDegreeDays(extremes.minimum, extremes.maximum, settings.growingBaseC, settings.growingCeilingC)
      : null,
    referenceEtMm: complete ? referenceEt(etInputs) : null,
    referenceEtMissingInputs: Object.entries(etInputs)
      .filter(([, v]) => !numeric(v))
      .map(([k]) => k),
  };
}
