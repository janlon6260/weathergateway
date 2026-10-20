import { calibrationDefaults } from '../shared/meteorology-settings.js';
const limits = {
  indoorTemperatureC: [-40, 85],
  indoorHumidityPct: [0, 100],
  temperatureC: [-90, 65],
  humidityPct: [0, 100],
  pressureHpa: [800, 1150],
  stationPressureHpa: [200, 1150],
  windSpeedMs: [0, 120],
  windMeanMs: [0, 120],
  windGustMs: [0, 150],
  solarWm2: [0, 2000],
};
const numeric = (v) => typeof v === 'number' && Number.isFinite(v);
export function calibrate(station, body) {
  const raw = { ...body.measurements },
    m = { ...raw },
    c = { ...calibrationDefaults, ...station.calibration },
    flags = [];
  for (const key of ['temperatureC', 'indoorTemperatureC'])
    if (numeric(m[key])) m[key] += c.temperatureOffsetC;
  for (const key of ['humidityPct', 'indoorHumidityPct']) if (numeric(m[key])) m[key] += c.humidityOffsetPct;
  for (const key of ['pressureHpa', 'stationPressureHpa']) if (numeric(m[key])) m[key] += c.pressureOffsetHpa;
  for (const key of ['windSpeedMs', 'windMeanMs', 'windGustMs']) if (numeric(m[key])) m[key] *= c.windFactor;
  if (numeric(m.windDirectionDeg))
    m.windDirectionDeg = (m.windDirectionDeg + c.windDirectionOffsetDeg + 360) % 360;
  if (numeric(m.solarWm2)) m.solarWm2 *= c.solarFactor;
  for (const [metric, [low, high]] of Object.entries(limits))
    if (numeric(m[metric]) && (m[metric] < low || m[metric] > high)) {
      m[metric] = null;
      flags.push({ metric, reason: 'outside-calibrated-range' });
    }
  body.rawMeasurements = raw;
  body.measurements = m;
  body.quality = { ...body.quality, flags };
}
export function assessQuality(store, station, body) {
  const at = Date.parse(body.observedAt),
    flags = body.quality.flags;
  for (const rule of station.qualityRules || []) {
    const value = body.measurements[rule.metric];
    if (!numeric(value) || (body.freshFields && !body.freshFields.includes(rule.metric))) continue;
    const previous = store.db
      .prepare('SELECT * FROM sensor_quality WHERE station_id=? AND metric=?')
      .get(station.id, rule.metric);
    if (previous && at <= previous.last_at) continue;
    const elapsed = previous ? at - previous.last_at : Infinity;
    const change =
      previous &&
      rule.maximumChangePerMinute !== null &&
      elapsed < 300000 &&
      (Math.abs(value - previous.value) * 60000) / elapsed > rule.maximumChangePerMinute;
    const changedAt = !previous || previous.value !== value || elapsed > 300000 ? at : previous.changed_at;
    const stuck = rule.stuckSeconds > 0 && at - changedAt >= rule.stuckSeconds * 1000;
    if (change || stuck) {
      flags.push({ metric: rule.metric, reason: change ? 'rate-of-change' : 'unchanged-sensor' });
      if (rule.action === 'missing') body.measurements[rule.metric] = null;
    }
    store.db
      .prepare('INSERT OR REPLACE INTO sensor_quality VALUES (?,?,?,?,?)')
      .run(station.id, rule.metric, at, value, changedAt);
  }
}
