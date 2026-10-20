import { DateTime } from 'luxon';
import { meteorology } from './weather-analytics.js';
import { rainCoverageComplete } from './davis-iss.js';

export function recordRainIncrement(store, station, body, before) {
  const at = Date.parse(body.observedAt),
    day = DateTime.fromMillis(at, { zone: 'Europe/Oslo' }).toISODate();
  const after = store.db
    .prepare('SELECT * FROM rain_state WHERE station_id=? AND day=?')
    .get(station.id, day);
  if (!after || after.last_at !== at || (before && before.last_at >= at)) return;
  const sameDay = before?.day === day,
    amount = Math.max(0, after.total_mm - (sameDay ? before.total_mm : 0));
  const from =
    before && (sameDay || body.iss)
      ? before.last_at
      : DateTime.fromISO(day, { zone: 'Europe/Oslo' }).toMillis();
  const complete = body.iss ? before && !body.quality?.rainCounterGap : after.unit !== 'iss-incomplete';
  store.db
    .prepare('INSERT OR IGNORE INTO rain_increments VALUES (?,?,?,?,?)')
    .run(station.id, from, at, amount, Number(Boolean(complete)));
}
export function rainWindow(store, stationId, start, end) {
  const rows = store.db
    .prepare(
      'SELECT * FROM rain_increments WHERE station_id=? AND end_at>? AND start_at<? ORDER BY start_at,end_at',
    )
    .all(stationId, start, end);
  let observedMm = 0,
    coveredMs = 0,
    cursor = start,
    boundaryAmbiguous = false;
  for (const row of rows) {
    if (row.start_at >= start && row.end_at <= end) observedMm += row.amount_mm;
    else if (row.amount_mm > 0) boundaryAmbiguous = true;
    if (row.complete) {
      const a = Math.max(cursor, start, row.start_at),
        b = Math.min(end, row.end_at);
      if (b > a) {
        coveredMs += b - a;
        cursor = b;
      }
    }
  }
  const coverage = Math.min(1, coveredMs / (end - start));
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    observedMm,
    coverage,
    boundaryAmbiguous,
    totalMm: coverage >= 0.999999 && !boundaryAmbiguous ? observedMm : null,
    method: 'counter-intervals-no-interpolation-v1',
  };
}
export function rainDayWindow(date, startHour = 0) {
  const day = DateTime.fromISO(date, { zone: 'Europe/Oslo' }).startOf('day');
  return [day.set({ hour: startHour }).toMillis(), day.plus({ days: 1 }).set({ hour: startHour }).toMillis()];
}
export function rainStatistics(store, station, from, to) {
  const settings = meteorology(station),
    rows = store.db
      .prepare('SELECT * FROM rain_state WHERE station_id=? AND day>=? AND day<=? ORDER BY day')
      .all(station.id, from, to),
    days = new Map(rows.map((row) => [row.day, row]));
  let wet = 0,
    dry = 0,
    longestWet = 0,
    longestDry = 0;
  const summary = [];
  for (
    let date = DateTime.fromISO(from, { zone: 'Europe/Oslo' });
    date.toISODate() <= to;
    date = date.plus({ days: 1 })
  ) {
    const key = date.toISODate(),
      row = days.get(key),
      complete =
        date.plus({ days: 1 }).toMillis() <= store.clock() &&
        rainCoverageComplete(row, station.rainCounterMmPerUnit, store.clock());
    if (!complete) {
      if (date.plus({ days: 1 }).toMillis() <= store.clock()) wet = dry = 0;
      summary.push({ date: key, rainMm: null });
      continue;
    }
    const isWet = row.total_mm >= settings.wetDayThresholdMm;
    wet = isWet ? wet + 1 : 0;
    dry = isWet ? 0 : dry + 1;
    longestWet = Math.max(longestWet, wet);
    longestDry = Math.max(longestDry, dry);
    const [start, end] = rainDayWindow(key, settings.rainDayStartHour);
    summary.push({
      date: key,
      rainMm: row.total_mm,
      wet: isWet,
      rainDay: rainWindow(store, station.id, start, end),
    });
  }
  const [start] = rainDayWindow(from),
    [, end] = rainDayWindow(to),
    increments = store.db
      .prepare(
        'SELECT * FROM rain_increments WHERE station_id=? AND end_at>=? AND end_at<? AND amount_mm>0 ORDER BY end_at',
      )
      .all(station.id, start, end);
  const storms = [];
  for (const row of increments) {
    let storm = storms.at(-1);
    if (!storm || row.start_at - storm.lastAt >= 6 * 3600000) {
      storm = { firstAt: row.start_at, lastAt: row.end_at, observedMm: 0, complete: true };
      storms.push(storm);
    }
    storm.lastAt = row.end_at;
    storm.observedMm += row.amount_mm;
    storm.complete &&= Boolean(row.complete);
  }
  return {
    from,
    to,
    wetDayThresholdMm: settings.wetDayThresholdMm,
    rainDayStartHour: settings.rainDayStartHour,
    longestWetDays: longestWet,
    longestDryDays: longestDry,
    currentWetDays: wet,
    currentDryDays: dry,
    stormDryGapHours: 6,
    storms: storms.map((s) => ({
      ...s,
      firstAt: new Date(s.firstAt).toISOString(),
      lastAt: new Date(s.lastAt).toISOString(),
    })),
    days: summary,
  };
}
