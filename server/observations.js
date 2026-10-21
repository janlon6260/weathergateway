import { appendFileSync, openSync, fsyncSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { telemetrySchema } from './schema.js';
import { derived, algorithmVersion } from './meteo.js';
import { Rejected } from './store.js';
import { decodeLoop } from './davis.js';
import { assembleIss, accumulateIssRain, freshIssMeasurements, rainCoverageComplete } from './davis-iss.js';
import { queueDatabaseObservation } from './database-queue.js';
import { addTemporalObservation, rollingWind, climateDay } from './weather-analytics.js';
import { currentSolarMaximum } from './astronomy.js';
import { calibrate, assessQuality } from './data-quality.js';
import { renderTemplate } from './reports.js';
import { recordRainIncrement, rainWindow, rainStatistics } from './rain-statistics.js';
import { retainDisplay } from './admin-live.js';

const fields = {
  temperatureC: 'temp',
  humidityPct: 'hum',
  pressureHpa: 'press',
  windSpeedMs: 'wlatest',
  windMeanMs: 'wspeed',
  windGustMs: 'wgust',
  windDirectionDeg: 'bearing',
  indoorTemperatureC: 'intemp',
  indoorHumidityPct: 'inhum',
  rainRateMmH: 'rrate',
  solarWm2: 'SolarRad',
  uvIndex: 'UV',
};
const derivedFields = {
  dewPointC: 'dew',
  windChillC: 'wchill',
  heatIndexC: 'heatindex',
  apparentTemperatureC: 'apptemp',
  humidexC: 'humidex',
  beaufort: 'beaufort',
  cloudBaseEstimateM: 'cloudbasevalue',
};
const emptyLegacy = Object.fromEntries(
  'temp tempTL tempTH intemp dew dewpointTL dewpointTH apptemp apptempTL apptempTH wchill wchillTL heatindex heatindexTH humidex wlatest wspeed wgust wgustTM bearing avgbearing press pressTL pressTH pressL pressH rfall rrate rrateTM hum humTL humTH inhum inhumTL inhumTH forecast temptrend TtempTL TtempTH TdewpointTL TdewpointTH TapptempTL TapptempTH TwchillTL TheatindexTH TrrateTM ThourlyrainTH LastRainTipISO hourlyrainTH ThumTL ThumTH TinhumTL TinhumTH TpressTL TpressTH presstrendval Tbeaufort TwgustTM windTM bearingTM BearingRangeFrom10 BearingRangeTo10 UV UVTH SolarRad CurrentSolarMax SolarTM domwinddir windrun cloudbasevalue beaufort'
    .split(' ')
    .map((k) => [k, '']),
);
const format = (v, decimals = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(decimals) : '');
const statsCache = new WeakMap();
function addRollups(store, stationId, body, observed, rainClicks) {
  if (!body.sensorContact) return;
  const day = DateTime.fromMillis(observed, { zone: 'Europe/Oslo' }).toISODate();
  const increment = store.db
    .prepare(`INSERT INTO rollups VALUES (?,?,?,?,?,?,1,?,?) ON CONFLICT(station_id,period,metric) DO UPDATE SET
    min_at=CASE WHEN excluded.minimum<minimum OR (excluded.minimum=minimum AND excluded.min_at<min_at) THEN excluded.min_at ELSE min_at END,
    max_at=CASE WHEN metric='_samples' THEN MAX(max_at,excluded.max_at) WHEN excluded.maximum>maximum OR (excluded.maximum=maximum AND excluded.max_at<max_at) THEN excluded.max_at ELSE max_at END,
    minimum=MIN(minimum,excluded.minimum),maximum=MAX(maximum,excluded.maximum),total=total+excluded.total,samples=samples+1`);
  for (const [metric, v] of Object.entries({ ...body.measurements, ...body.derived, _samples: 1 }))
    if (
      typeof v === 'number' &&
      Number.isFinite(v) &&
      (!body.freshFields || !(metric in body.measurements) || body.freshFields.includes(metric))
    ) {
      for (const period of [day, new Date(Math.floor(observed / 3600000) * 3600000).toISOString()])
        increment.run(stationId, period, metric, v, v, v, observed, observed);
    }
  if (body.source?.protocol === 'davis-iss') {
    return;
  }
  const counter = typeof rainClicks === 'number' ? rainClicks : body.measurements.rainTodayMm,
    unit = typeof rainClicks === 'number' ? 'clicks' : 'mm';
  if (typeof counter === 'number' && Number.isFinite(counter)) {
    const prior = store.db
      .prepare('SELECT * FROM rain_state WHERE station_id=? AND day=?')
      .get(stationId, day);
    const scale = unit === 'clicks' ? store.confirmedValue(`station:${stationId}`).rainCounterMmPerUnit : 1;
    if (!prior)
      store.db
        .prepare('INSERT INTO rain_state VALUES (?,?,?,?,?,?,0)')
        .run(stationId, day, observed, counter, unit, counter * scale);
    else if (observed > prior.last_at && prior.unit === unit) {
      const reset = counter < prior.last_counter;
      store.db
        .prepare(
          'UPDATE rain_state SET last_at=?,last_counter=?,total_mm=total_mm+?,resets=resets+? WHERE station_id=? AND day=?',
        )
        .run(
          observed,
          counter,
          (reset ? counter : counter - prior.last_counter) * scale,
          Number(reset),
          stationId,
          day,
        );
    }
  }
}
export function dayRange(date, zone = 'Europe/Oslo') {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  if (!start.isValid || start.toISODate() !== date) throw new Rejected('Ugyldig dato', 400);
  return [start.toMillis(), start.plus({ days: 1 }).toMillis()];
}
export function ingest(store, identity, input, { enqueueDatabase = true, historical = false } = {}) {
  const message = telemetrySchema.parse(input);
  if (identity !== message.stationId) throw new Rejected('Stasjonsidentiteten stemmer ikke', 403);
  const stationRecord = store.confirmedConfiguration(`station:${identity}`),
    station = stationRecord.value;
  if (!station.enabled || station.model === 'Netatmo')
    throw new Rejected('Stasjonen mottar ikke ESP-data', 403);
  const observed = Date.parse(message.observedAt),
    now = store.clock(),
    settings = store.current('gateway').value;
  if (
    observed > now + 60000 ||
    observed < (historical ? Date.UTC(1900, 0, 1) : now - settings.retentionDays * 86400000)
  )
    throw new Rejected('Måletid er utenfor tillatt tidsrom', 422);
  let rainClicks;
  try {
    if (message.source?.protocol === 'davis-iss') {
      assembleIss(store, message, station);
    } else if (message.source) {
      const decoded = decodeLoop(Buffer.from(message.source.packet, 'base64'), station.rainCounterMmPerUnit);
      message.measurements = decoded.measurements;
      message.sensorContact = message.sensorContact && decoded.sensorContact;
      rainClicks = decoded.rawFields.rainTodayClicks;
    }
  } catch (error) {
    if (String(error.code || '').startsWith('SQLITE_')) throw error;
    throw new Rejected('Ugyldig Davis-pakke eller senderidentitet', 422);
  }
  const body = {
    ...message,
    derived: message.sensorContact ? derived(message.measurements) : {},
    algorithmVersion,
    calibrationRevision: historical ? 0 : stationRecord.revision,
    receivedAt: new Date(now).toISOString(),
  };
  if (historical) {
    body.rawMeasurements = { ...body.measurements };
    body.quality = { flags: [] };
    body.imported = { calibration: 'source-values', qualityRules: 'not-reapplied' };
  } else calibrate(station, body);
  body.derived = body.sensorContact ? derived(body.measurements) : {};
  const inserted = store.db
    .transaction(() => {
      if (
        store.db
          .prepare('SELECT 1 FROM observations WHERE station_id=? AND boot_id=? AND sequence=?')
          .get(identity, message.bootId, message.sequence)
      )
        return 0;
      if (!historical) assessQuality(store, station, body);
      body.derived = body.sensorContact ? derived(body.measurements) : {};
      const result = store.db
        .prepare('INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?)')
        .run(identity, message.bootId, message.sequence, observed, now, JSON.stringify(body));
      if (result.changes) {
        if (body.sensorContact)
          store.db
            .prepare(
              'INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(meta.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)',
            )
            .run(`last_valid_sensor:${identity}`, String(observed));
        addTemporalObservation(store, station, body);
        if (body.iss) {
          body.windStatistics = rollingWind(store, station, observed);
          body.measurements.windMeanMs = body.windStatistics.meanMs;
          body.measurementTimes.windMeanMs = body.observedAt;
          body.freshFields.push('windMeanMs');
        }
        const beforeRain = store.db
          .prepare('SELECT * FROM rain_state WHERE station_id=? ORDER BY last_at DESC LIMIT 1')
          .get(identity);
        if (body.iss) {
          accumulateIssRain(
            store,
            identity,
            body,
            observed,
            DateTime.fromMillis(observed, { zone: 'Europe/Oslo' }).toISODate(),
          );
          recordRainIncrement(store, station, body, beforeRain);
          const rainAt = store.db
            .prepare('SELECT MAX(end_at) AS at FROM rain_increments WHERE station_id=? AND end_at<=?')
            .get(identity, observed).at;
          if (rainAt) {
            body.rainWindows = {
              lastHour: rainWindow(store, identity, rainAt - 3600000, rainAt),
              last24Hours: rainWindow(store, identity, rainAt - 86400000, rainAt),
            };
            body.measurements.rainLastHourMm = body.rainWindows.lastHour.totalMm;
          }
        }
        addRollups(store, identity, body, observed, rainClicks);
        if (!body.iss) recordRainIncrement(store, station, body, beforeRain);
        store.db
          .prepare('UPDATE observations SET body=? WHERE station_id=? AND boot_id=? AND sequence=?')
          .run(JSON.stringify(body), identity, message.bootId, message.sequence);
        if (enqueueDatabase) queueDatabaseObservation(store, station, body);
        if (!historical) retainDisplay(store,identity,body);
      }
      return result.changes;
    })
    .immediate();
  if (!inserted) return false;
  statsCache.delete(store);
  const date = DateTime.fromMillis(observed, { zone: 'utc' }).toISODate();
  appendFileSync(
    join(store.stationDirectory(identity, 'raw'), `${date}.jsonl`),
    JSON.stringify(body) + '\n',
    { mode: 0o600 },
  );
  return true;
}
export function latest(store, stationId) {
  const row = store.db
    .prepare(
      'SELECT body FROM observations WHERE station_id=? ORDER BY observed_at DESC,received_at DESC LIMIT 1',
    )
    .get(stationId);
  return row ? JSON.parse(row.body) : null;
}
export function statistics(store, stationId, start, end) {
  const date = DateTime.fromMillis(start, { zone: 'Europe/Oslo' }).toISODate();
  const expected = dayRange(date);
  if (start !== expected[0] || end !== expected[1])
    throw new Rejected('Statistikk krever et helt lokalt døgn', 400);
  const rows = store.db.prepare('SELECT * FROM rollups WHERE station_id=? AND period=?').all(stationId, date),
    result = { samples: 0 };
  for (const r of rows) {
    if (r.metric === '_samples') {
      result.samples = r.samples;
      result.firstAt = r.min_at;
      result.lastAt = r.max_at;
    } else
      Object.assign(result, {
        [`${r.metric}_MIN`]: r.minimum,
        [`${r.metric}_MAX`]: r.maximum,
        [`${r.metric}_AVG`]: r.total / r.samples,
      });
  }
  return result;
}
export function dailyStatistics(store, stationId, now = store.clock()) {
  let cache = statsCache.get(store);
  if (!cache) statsCache.set(store, (cache = new Map()));
  const date = DateTime.fromMillis(now, { zone: 'Europe/Oslo' }).toISODate(),
    key = `${stationId}:${date}`,
    old = cache.get(key);
  if (old && now - old.at < 15000 && now >= old.at) return old.stats;
  const rows = store.db.prepare('SELECT * FROM rollups WHERE station_id=? AND period=?').all(stationId, date),
    stats = {};
  for (const row of rows)
    Object.assign(stats, {
      [`${row.metric}_MIN`]: row.minimum,
      [`${row.metric}_MAX`]: row.maximum,
      [`${row.metric}_AVG`]: row.total / row.samples,
      [`${row.metric}_MIN_AT`]: row.min_at,
      [`${row.metric}_MAX_AT`]: row.max_at,
    });
  cache.set(key, { at: now, stats });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return stats;
}
export function legacy(store, station, message = latest(store, station.id)) {
  const settings = store.current('gateway').value;
  if (!message)
    return {
      ...emptyLegacy,
      WindRoseData: [],
      date: '',
      timeUTC: '',
      status: 'unknown',
      lastValidTime: null,
      SensorContactLost: '1',
    };
  const time = DateTime.fromISO(message.observedAt, { zone: 'utc' }),
    age = store.clock() - time.toMillis(),
    m = message.iss ? freshIssMeasurements(message, store.clock()) : message.measurements,
    stats = dailyStatistics(store, station.id);
  const wind = rollingWind(store, station, store.clock());
  const result = {
    ...emptyLegacy,
    WindRoseData: [],
    date: time.setZone('Europe/Oslo').toFormat('HH:mm'),
    dateFormat: 'HH:mm',
    timeUTC: time.toFormat('yyyy,M,d,H,m,s'),
    tempunit: 'C',
    windunit: 'm/s',
    pressunit: 'hPa',
    rainunit: 'mm',
    cloudbaseunit: 'm',
    SensorContactLost: message.sensorContact ? '0' : '1',
    lastValidTime: message.sensorContact ? time.toISO() : null,
    status:
      !message.sensorContact || age >= settings.downSeconds * 1000
        ? 'red'
        : age >= settings.warningSeconds * 1000
          ? 'orange'
          : 'green',
    thresholds: { warningMs: settings.warningSeconds * 1000, downMs: settings.downSeconds * 1000 },
    instantWindAvailable: typeof m.windSpeedMs === 'number',
    version: 'WeatherGateway',
    build: '1',
    ver: algorithmVersion,
  };
  for (const [field, output] of Object.entries(fields))
    result[output] = format(
      m[field],
      ['humidityPct', 'indoorHumidityPct', 'windDirectionDeg'].includes(field) ? 0 : 1,
    );
  if (message.iss) result.wspeed = format(wind.meanMs);
  result.avgbearing = format(wind.directionDeg, 0);
  const climate = climateDay(store, station, time.setZone('Europe/Oslo').toISODate());
  if (climate.windRose.some((bin) => bin.percent !== null)) {
    result.WindRoseData = climate.windRose.map((bin) => bin.percent);
  }
  result.windrun = format(climate.windRunKm);
  result.windCoverage = wind.coverage;
  result.windWindowSeconds = wind.windowSeconds;
  result.gust3SecondsMs = format(wind.gustMs);
  result.CurrentSolarMax = format(currentSolarMaximum(station, time.toMillis()), 0);
  const rainAt = store.db
    .prepare('SELECT MAX(end_at) AS at FROM rain_increments WHERE station_id=? AND amount_mm>0')
    .get(station.id).at;
  result.LastRainTipISO = rainAt ? new Date(rainAt).toISOString() : '';
  const derivedNow = message.iss ? (message.sensorContact ? derived(m) : {}) : message.derived;
  for (const [field, output] of Object.entries(derivedFields))
    result[output] = format(derivedNow?.[field], field === 'beaufort' ? 0 : 1);
  const observedDay = time.setZone('Europe/Oslo').toISODate(),
    rain = store.db
      .prepare('SELECT * FROM rain_state WHERE station_id=? AND day=?')
      .get(station.id, observedDay);
  result.rfall =
    rain && !rainCoverageComplete(rain, station.rainCounterMmPerUnit, store.clock())
      ? ''
      : format(rain?.total_mm ?? m.rainTodayMm);
  for (const [field, low, high] of [
    ['temperatureC', 'tempTL', 'tempTH'],
    ['humidityPct', 'humTL', 'humTH'],
    ['pressureHpa', 'pressTL', 'pressTH'],
    ['indoorHumidityPct', 'inhumTL', 'inhumTH'],
  ]) {
    result[low] = format(stats[`${field}_MIN`]);
    result[high] = format(stats[`${field}_MAX`]);
    result[`T${low}`] = stats[`${field}_MIN_AT`]
      ? DateTime.fromMillis(stats[`${field}_MIN_AT`], { zone: 'Europe/Oslo' }).toFormat('HH:mm')
      : '';
    result[`T${high}`] = stats[`${field}_MAX_AT`]
      ? DateTime.fromMillis(stats[`${field}_MAX_AT`], { zone: 'Europe/Oslo' }).toFormat('HH:mm')
      : '';
  }
  for (const [field, prefix] of [
    ['dewPointC', 'dewpoint'],
    ['apparentTemperatureC', 'apptemp'],
    ['windChillC', 'wchill'],
    ['heatIndexC', 'heatindex'],
  ]) {
    result[`${prefix}TL`] = format(stats[`${field}_MIN`]);
    result[`${prefix}TH`] = format(stats[`${field}_MAX`]);
    for (const [which, suffix] of [
      ['MIN', 'TL'],
      ['MAX', 'TH'],
    ])
      result[`T${prefix}${suffix}`] = stats[`${field}_${which}_AT`]
        ? DateTime.fromMillis(stats[`${field}_${which}_AT`], { zone: 'Europe/Oslo' }).toFormat('HH:mm')
        : '';
  }
  result.wgustTM = format(stats.windGustMs_MAX);
  result.rrateTM = format(stats.rainRateMmH_MAX);
  result.UVTH = format(stats.uvIndex_MAX);
  result.SolarTM = format(stats.solarWm2_MAX);
  for (const [field, target] of [
    ['windGustMs', 'TwgustTM'],
    ['rainRateMmH', 'TrrateTM'],
    ['rainLastHourMm', 'ThourlyrainTH'],
  ])
    result[target] = stats[`${field}_MAX_AT`]
      ? DateTime.fromMillis(stats[`${field}_MAX_AT`], { zone: 'Europe/Oslo' }).toFormat('HH:mm')
      : '';
  result.hourlyrainTH = format(stats.rainLastHourMm_MAX);
  return result;
}
export function snapshot(store) {
  return Object.fromEntries(
    store
      .stationList()
      .map((s) => store.confirmedConfiguration(s.scope))
      .filter((s) => s.value.enabled && s.value.model !== 'Netatmo')
      .map((s) => [s.value.key, legacy(store, s.value)]),
  );
}
export function exportStation(store, station) {
  const data = legacy(store, station);
  const directory = store.stationDirectory(station.id);
  // Status fields are generated by the consuming service, not accepted from files.
  const { status, thresholds, lastValidTime, ...file } = data;
  const target = join(directory, station.exportName),
    temporary = `${target}.tmp`;
  const fd = openSync(temporary, 'w', 0o640);
  try {
    writeFileSync(fd, JSON.stringify(file) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  for (const template of station.templates || []) {
    const path = join(directory, template.name),
      text = renderTemplate(
        template.content,
        { station, weather: data },
        { html: template.name.endsWith('.html') },
      );
    const file = openSync(`${path}.tmp`, 'w', 0o640);
    try {
      writeFileSync(file, text);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(`${path}.tmp`, path);
  }
  return target;
}
export function history(store, stationId, date) {
  const [start, end] = dayRange(date);
  const rows = store.db
    .prepare(
      'SELECT * FROM rollups WHERE station_id=? AND period>=? AND period<? AND length(period)>10 ORDER BY period,metric',
    )
    .all(stationId, new Date(start).toISOString(), new Date(end).toISOString());
  const buckets = new Map();
  for (const row of rows) {
    if (!buckets.has(row.period)) buckets.set(row.period, { at: row.period, samples: 0 });
    const b = buckets.get(row.period);
    b.samples = Math.max(b.samples, row.samples);
    b[row.metric] = row.total / row.samples;
    b[`${row.metric}_MIN`] = row.minimum;
    b[`${row.metric}_MAX`] = row.maximum;
  }
  return {
    stationId,
    date,
    timezone: 'Europe/Oslo',
    summary: statistics(store, stationId, start, end),
    hourly: [...buckets.values()],
  };
}

export function periodReport(store, stationId, period) {
  if (!/^\d{4}(-\d{2})?$/.test(period)) throw new Rejected('Perioden må være YYYY eller YYYY-MM', 400);
  const start = DateTime.fromISO(period.length === 4 ? `${period}-01-01` : `${period}-01`, {
    zone: 'Europe/Oslo',
  });
  if (!start.isValid) throw new Rejected('Ugyldig periode', 400);
  const end = start.plus(period.length === 4 ? { years: 1 } : { months: 1 });
  const rows = store.db
    .prepare(
      'SELECT * FROM rollups WHERE station_id=? AND length(period)=10 AND period>=? AND period<? ORDER BY period,metric',
    )
    .all(stationId, start.toISODate(), end.toISODate());
  const days = {};
  for (const r of rows) {
    days[r.period] ||= {};
    days[r.period][r.metric] = {
      min: r.minimum,
      max: r.maximum,
      mean: r.total / r.samples,
      count: r.samples,
      minAt: new Date(r.min_at).toISOString(),
      maxAt: new Date(r.max_at).toISOString(),
    };
  }
  const rain = store.db
    .prepare('SELECT * FROM rain_state WHERE station_id=? AND day>=? AND day<? ORDER BY day')
    .all(stationId, start.toISODate(), end.toISODate());
  for (const r of rain) {
    days[r.day] ||= {};
    const complete = rainCoverageComplete(
      r,
      store.current(`station:${stationId}`).value.rainCounterMmPerUnit,
      store.clock(),
    );
    days[r.day].rainfallMm = complete ? r.total_mm : null;
    if (!complete) days[r.day].rainfallObservedMm = r.total_mm;
    days[r.day].rainfallComplete = complete;
    days[r.day].counterResets = r.resets;
  }
  const station = store.confirmedValue(`station:${stationId}`);
  for (let date = start; date < end; date = date.plus({ days: 1 })) days[date.toISODate()] ||= {};
  for (const [date, day] of Object.entries(days)) day.climate = climateDay(store, station, date);
  const completeRain = Object.values(days).filter((day) => day.rainfallComplete);
  const completeClimate = Object.values(days).filter((day) => day.climate?.complete);
  const sum = (key) => {
    const values = completeClimate.map((d) => d.climate[key]).filter((v) => typeof v === 'number');
    return values.length
      ? { value: values.reduce((a, b) => a + b, 0), days: values.length }
      : { value: null, days: 0 };
  };
  return {
    stationId,
    period,
    timezone: 'Europe/Oslo',
    algorithmVersion,
    days,
    rainAnalysis: rainStatistics(store, station, start.toISODate(), end.minus({ days: 1 }).toISODate()),
    totals: {
      rainObservedMm: rain.length ? rain.reduce((n, d) => n + d.total_mm, 0) : null,
      rainCompleteMm: completeRain.length ? completeRain.reduce((n, d) => n + d.rainfallMm, 0) : null,
      rainCompleteDays: completeRain.length,
      heatingDegreeDays: sum('heatingDegreeDays'),
      coolingDegreeDays: sum('coolingDegreeDays'),
      growingDegreeDays: sum('growingDegreeDays'),
      referenceEtMm: sum('referenceEtMm'),
    },
  };
}
