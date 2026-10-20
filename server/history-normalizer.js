import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { Rejected } from './store.js';
import { telemetrySchema } from './schema.js';

function namespaceId(stationId, format) {
  const bytes = createHash('sha256').update(`${stationId}:history:${format}:v1`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const s = bytes.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function normalizeHistory(row, stationId, { format = 'telemetry', windUnit, fold, stationKey } = {}) {
  if (format === 'telemetry' && row.version === 1) return telemetrySchema.parse(row);
  let observedAt, measurements;
  if (format === 'wx-data') {
    if (row.station_id !== undefined && (!stationKey || row.station_id !== stationKey))
      throw new Rejected('Historikkraden tilhører en annen stasjon', 400);
    if (!['kmh', 'ms'].includes(windUnit))
      throw new Rejected('Oppgi vindenhet eksplisitt for wx_data-import', 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !/^\d{2}:\d{2}:\d{2}$/.test(row.time))
      throw new Rejected('wx_data krever dato YYYY-MM-DD og tid HH:mm:ss', 400);
    let local = DateTime.fromSQL(`${row.date} ${row.time}`, { zone: 'Europe/Oslo' });
    if (!local.isValid || local.toFormat('yyyy-MM-dd HH:mm:ss') !== `${row.date} ${row.time}`)
      throw new Rejected('Lokal tid finnes ikke ved overgang til sommertid', 400);
    const possible = local.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis());
    if (possible.length > 1) {
      if (!['earlier', 'later'].includes(fold))
        throw new Rejected('Tvetydig lokalt klokkeslett: oppgi earlier/later eksplisitt', 400);
      local = fold === 'earlier' ? possible[0] : possible.at(-1);
    }
    observedAt = local.toUTC().toISO();
    measurements = {};
    for (const [column, metric] of Object.entries({
      temperature: 'temperatureC',
      outdoor_humidity: 'humidityPct',
      barometer: 'pressureHpa',
      rain_rate: 'rainRateMmH',
      daily_rainfall: 'rainTodayMm',
      average_windspeed: 'windMeanMs',
      gust_windspeed: 'windGustMs',
      wind_direction: 'windDirectionDeg',
    })) {
      const value = row[column];
      if (value === undefined || value === null || value === '') measurements[metric] = null;
      else {
        if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)))
          throw new Rejected(`Ugyldig historikkfelt: ${column}`, 400);
        measurements[metric] = Number(value);
      }
      if (
        windUnit === 'kmh' &&
        ['windMeanMs', 'windGustMs'].includes(metric) &&
        measurements[metric] !== null
      )
        measurements[metric] /= 3.6;
    }
    // SQL mean wind remains a mean; it is never relabelled as instant wind.
  } else if (format === 'telemetry') {
    observedAt = row.observedAt;
    measurements = row.measurements;
  } else throw new Rejected('Ukjent historikkformat', 400);
  const sequence = Date.parse(observedAt);
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Rejected('Historikkimport krever en gyldig UTC-tid fra 1970 eller senere', 400);
  return telemetrySchema.parse({
    version: 1,
    stationId,
    bootId: namespaceId(stationId, format),
    sequence,
    observedAt,
    firmware: `history-${format}-v1`,
    sensorContact: true,
    measurements,
  });
}
