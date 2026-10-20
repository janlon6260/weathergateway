// Independent implementation of the observed Davis ISS wire format.
// Protocol references, ambiguities and receiver profile: docs/davis-radio.md.
import { crcCcitt } from './davis.js';
import { DateTime } from 'luxon';

export const issAlgorithmVersion = 'wg-iss-1';
export const issRainGapMs = (mmPerTip) => ((128 * mmPerTip) / 5000) * 3600000;
export function rainCoverageComplete(rain, mmPerTip, at) {
  if (!rain || rain.unit === 'iss-incomplete') return false;
  const dayEnd = DateTime.fromISO(rain.day, { zone: 'Europe/Oslo' }).plus({ days: 1 }).toMillis();
  const target = Math.min(at, dayEnd),
    gap = target - rain.last_at;
  return (
    Number.isFinite(gap) && gap >= 0 && gap < (rain.unit === 'iss-tips' ? issRainGapMs(mmPerTip) : 60000)
  );
}
export const measurementLifetimeMs = {
  windSpeedMs: 15000,
  windMeanMs: 15000,
  windDirectionDeg: 15000,
  temperatureC: 60000,
  humidityPct: 150000,
  rainRateMmH: 60000,
  windGustMs: 120000,
  solarWm2: 150000,
  uvIndex: 150000,
  rainTodayMm: 60000,
};
export function freshIssMeasurements(message, at) {
  const result = { ...message.measurements };
  for (const metric of Object.keys(result)) {
    const age = at - Date.parse(message.measurementTimes?.[metric]);
    if (!Number.isFinite(age) || age < 0 || age > (measurementLifetimeMs[metric] || 0)) result[metric] = null;
  }
  return result;
}
const bounded = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : null);
export function decodeIss(packet, model, rainMmPerTip) {
  if (
    !Buffer.isBuffer(packet) ||
    packet.length !== 10 ||
    crcCcitt(packet.subarray(0, 8)) !== 0 ||
    packet[8] !== 255 ||
    packet[9] !== 255
  )
    throw new Error('Ugyldig direkte ISS-pakke, CRC eller repeaterpakke');
  if (
    !['Davis Vantage Vue', 'Davis Vantage Pro2'].includes(model) ||
    !Number.isFinite(rainMmPerTip) ||
    rainMmPerTip <= 0 ||
    rainMmPerTip > 10
  )
    throw new Error('Ugyldig ISS-modell eller regnkalibrering');
  const type = packet[0] >> 4;
  const measurements = {
    windSpeedMs: packet[1] === 255 ? null : bounded(packet[1] * 0.44704, 0, 120),
    windDirectionDeg:
      packet[2] === 0
        ? 0
        : model === 'Davis Vantage Vue'
          ? (packet[2] * 1.40625 + 0.3) % 360
          : 9 + (packet[2] * 342) / 255,
  };
  const rawFields = {};
  switch (type) {
    case 8: {
      const raw = packet.readInt16BE(3);
      measurements.temperatureC = [32767, -32768].includes(raw)
        ? null
        : bounded((raw / 160 - 32) / 1.8, -90, 65);
      break;
    }
    case 10:
      measurements.humidityPct = bounded((((packet[4] & 0x30) << 4) | packet[3]) / 10, 0, 100);
      break;
    case 4:
      measurements.uvIndex = packet[3] === 255 ? null : bounded((packet.readUInt16BE(3) >> 6) / 50, 0, 30);
      break;
    case 6:
      measurements.solarWm2 =
        packet[3] === 255 ? null : bounded((packet.readUInt16BE(3) >> 6) * 1.757936, 0, 2000);
      break;
    case 9:
      measurements.windGustMs = packet[3] === 255 ? null : bounded(packet[3] * 0.44704, 0, 150);
      rawFields.gustInterval = packet[5] >> 4;
      break;
    case 5: {
      const interval = ((packet[4] & 0x30) >> 4) * 250 + packet[3];
      measurements.rainRateMmH =
        packet[3] === 255
          ? 0
          : interval === 0
            ? null
            : bounded((rainMmPerTip * 3600 * (packet[4] & 0x40 ? 16 : 1)) / interval, 0, 5000);
      break;
    }
    case 14:
      rawFields.rainCounterTips = packet[3] & 0x7f;
      break;
    // Other packet types are archived; they may still contain valid wind.
  }
  return {
    measurements,
    rawFields,
    type,
    transmitterId: (packet[0] & 7) + 1,
    batteryLow: Boolean(packet[0] & 8),
  };
}

export function assembleIss(store, message, station) {
  const decoded = decodeIss(
    Buffer.from(message.source.packet, 'base64'),
    station.model,
    station.rainCounterMmPerUnit,
  );
  const device = store.current(`device:${station.id}`).value;
  if (device.interface !== 'davis-iss-rfm69' || device.transmitterId !== decoded.transmitterId)
    throw new Error('ISS sender-ID stemmer ikke med enhetsinnstillingen');
  const observed = Date.parse(message.observedAt);
  const row = store.db
    .prepare(
      'SELECT body FROM observations WHERE station_id=? AND observed_at<=? ORDER BY observed_at DESC,received_at DESC LIMIT 1',
    )
    .get(station.id, observed);
  const prior = row ? JSON.parse(row.body) : null;
  const compatible =
    prior?.source?.protocol === 'davis-iss' &&
    prior.bootId === message.bootId &&
    prior.configurationHash === message.configurationHash;
  const measurements = compatible ? { ...(prior.rawMeasurements || prior.measurements) } : {};
  const measurementTimes = compatible ? { ...prior.measurementTimes } : {};
  for (const [metric, value] of Object.entries(decoded.measurements)) {
    measurements[metric] = value;
    measurementTimes[metric] = message.observedAt;
  }
  for (const metric of Object.keys(measurements)) {
    const age = observed - Date.parse(measurementTimes[metric]);
    if (!Number.isFinite(age) || age < 0 || age > (measurementLifetimeMs[metric] || 0))
      measurements[metric] = null;
  }
  const rain = store.db
    .prepare('SELECT * FROM rain_state WHERE station_id=? AND day=?')
    .get(station.id, DateTime.fromMillis(observed, { zone: 'Europe/Oslo' }).toISODate());
  measurements.rainTodayMm =
    rain && rain.unit === 'iss-tips' && rain.last_at <= observed ? rain.total_mm : null;
  if (rain && rain.last_at <= observed) measurementTimes.rainTodayMm = new Date(rain.last_at).toISOString();
  // Pressure and indoor climate are not transmitted by the ISS.
  message.measurements = measurements;
  message.measurementTimes = measurementTimes;
  message.freshFields = Object.keys(decoded.measurements);
  message.quality = { rainDayIncomplete: !rain || rain.unit !== 'iss-tips' };
  message.iss = {
    algorithmVersion: issAlgorithmVersion,
    type: decoded.type,
    transmitterId: decoded.transmitterId,
    batteryLow: decoded.batteryLow,
    ...decoded.rawFields,
  };
  return decoded;
}

export function accumulateIssRain(store, stationId, body, observed, day) {
  const counter = body.iss?.rainCounterTips;
  if (!Number.isInteger(counter)) return;
  const previous = store.db.prepare('SELECT * FROM iss_rain WHERE station_id=?').get(stationId);
  // Late observations remain archived but cannot advance a rolling counter.
  if (previous && observed <= previous.last_at) return;
  const scale = store.confirmedValue(`station:${stationId}`).rainCounterMmPerUnit;
  const elapsed = previous ? observed - previous.last_at : Infinity;
  const delta = previous ? (counter - previous.counter + 128) % 128 : 0;
  // With the accepted maximum of 5000 mm/h a full wrap could be hidden after
  // this interval. Refuse to manufacture rain through an ambiguous outage.
  const continuous =
    previous &&
    previous.transmitter_id === body.iss.transmitterId &&
    elapsed < issRainGapMs(scale) &&
    delta * scale <= (5000 * elapsed) / 3600000 + scale;
  const priorDay = store.db
    .prepare('SELECT * FROM rain_state WHERE station_id=? AND day=?')
    .get(stationId, day);
  const sameDay =
    previous && DateTime.fromMillis(previous.last_at, { zone: 'Europe/Oslo' }).toISODate() === day;
  const incomplete = !continuous || (!priorDay && sameDay) || priorDay?.unit === 'iss-incomplete';
  const added = continuous ? delta * scale : 0;
  store.db
    .prepare(
      `INSERT INTO rain_state VALUES (?,?,?,?,?,?,?) ON CONFLICT(station_id,day) DO UPDATE SET last_at=excluded.last_at,last_counter=excluded.last_counter,unit=excluded.unit,total_mm=total_mm+excluded.total_mm,resets=resets+excluded.resets`,
    )
    .run(
      stationId,
      day,
      observed,
      counter,
      incomplete ? 'iss-incomplete' : 'iss-tips',
      added,
      Number(!continuous),
    );
  store.db
    .prepare('INSERT OR REPLACE INTO iss_rain VALUES (?,?,?,?)')
    .run(stationId, body.iss.transmitterId, observed, counter);
  body.measurements.rainTodayMm = incomplete ? null : (priorDay?.total_mm || 0) + added;
  body.measurementTimes.rainTodayMm = body.observedAt;
  body.freshFields.push('rainTodayMm');
  body.quality = { ...body.quality, rainCounterGap: !continuous, rainDayIncomplete: incomplete };
}
