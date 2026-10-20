import { DateTime } from 'luxon';
import { Rejected } from './store.js';
export function records(store, stationId, { from = '0000-01-01', to = '9999-12-31' } = {}) {
  if (![from, to].every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)) || from > to)
    throw new Rejected('Ugyldig rekordperiode', 400);
  const rows = store.db
      .prepare(
        'SELECT * FROM rollups WHERE station_id=? AND length(period)=10 AND period>=? AND period<=? ORDER BY period',
      )
      .all(stationId, from, to),
    metrics = {};
  for (const row of rows) {
    if (row.metric === '_samples') continue;
    const value = (metrics[row.metric] ||= {
      minimum: row.minimum,
      maximum: row.maximum,
      minAt: row.min_at,
      maxAt: row.max_at,
      total: 0,
      samples: 0,
    });
    if (row.minimum < value.minimum || (row.minimum === value.minimum && row.min_at < value.minAt)) {
      value.minimum = row.minimum;
      value.minAt = row.min_at;
    }
    if (row.maximum > value.maximum || (row.maximum === value.maximum && row.max_at < value.maxAt)) {
      value.maximum = row.maximum;
      value.maxAt = row.max_at;
    }
    value.total += row.total;
    value.samples += row.samples;
  }
  for (const value of Object.values(metrics)) {
    value.sampleMean = value.total / value.samples;
    value.minAt = new Date(value.minAt).toISOString();
    value.maxAt = new Date(value.maxAt).toISOString();
    delete value.total;
  }
  return { stationId, from, to, method: 'daily-observed-extremes-v1', metrics };
}
export function climateText(station, report) {
  const fmt = (value, width = 8) =>
    (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '--').padStart(width);
  const lines = [
    `WEATHER GATEWAY CLIMATE REPORT 1`,
    `${station.name} | ${report.period} | Europe/Oslo | SI`,
    'Missing/incomplete: --; sunshine is a global-radiation proxy.',
    'Date          MeanT    MaxT    MinT    Rain   WindRun     HDD     CDD     GDD      ET',
  ];
  for (const [date, day] of Object.entries(report.days))
    lines.push(
      date +
        fmt(day.climate?.means.temperatureC) +
        fmt(day.temperatureC?.max) +
        fmt(day.temperatureC?.min) +
        fmt(day.rainfallMm) +
        fmt(day.climate?.windRunKm, 10) +
        fmt(day.climate?.heatingDegreeDays) +
        fmt(day.climate?.coolingDegreeDays) +
        fmt(day.climate?.growingDegreeDays) +
        fmt(day.climate?.referenceEtMm),
    );
  lines.push('Temperature °C; rain/ET mm; windrun km; degree days °C·day.');
  return lines.join('\n') + '\n';
}
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function renderTemplate(content, context, { html = false } = {}) {
  if (content.length > 32000) throw new Rejected('Malen er for stor', 400);
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const rendered = content.replace(/{{\s*([A-Za-z][A-Za-z0-9_.]{0,100})\s*}}/g, (_match, path) => {
    let value = context;
    for (const part of path.split('.')) {
      if (forbidden.has(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part))
        throw new Rejected(`Ukjent malfelt: ${path}`, 400);
      value = value[part];
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
      throw new Rejected(`Malfeltet er ikke en enkeltverdi: ${path}`, 400);
    return value === null ? '' : html ? escape(value) : String(value);
  });
  if (/{{|}}/.test(rendered)) throw new Rejected('Ugyldig maluttrykk', 400);
  return rendered;
}
export function reportPeriodBounds(period) {
  if (!/^\d{4}(?:-\d{2})?$/.test(period)) throw new Rejected('Ugyldig periode', 400);
  const start = DateTime.fromISO(period.length === 4 ? `${period}-01-01` : `${period}-01`, {
    zone: 'Europe/Oslo',
  });
  if (!start.isValid) throw new Rejected('Ugyldig periode', 400);
  return { start, end: start.plus(period.length === 4 ? { years: 1 } : { months: 1 }) };
}
