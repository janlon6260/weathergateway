import psychro from './vendor/psychrolib.cjs';
psychro.SetUnitSystem(psychro.SI);
// Versioned methods: ASHRAE/PsychroLib, NWS wind chill/heat index,
// BOM apparent temperature, ECCC humidex. References: docs/calculations.md.
export const algorithmVersion = 'wg-meteo-2';
const valid = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));
export function dewPoint(t, rh) {
  if (!valid(t, rh) || rh <= 0 || rh > 100 || t < -90 || t > 65) return null;
  try {
    return psychro.GetTDewPointFromRelHum(t, rh / 100);
  } catch {
    return null;
  }
}
export function wetBulb(t, rh, stationPressureHpa) {
  if (
    !valid(t, rh, stationPressureHpa) ||
    t < -90 ||
    t > 65 ||
    rh <= 0 ||
    rh > 100 ||
    stationPressureHpa < 200 ||
    stationPressureHpa > 1150
  )
    return null;
  try {
    return psychro.GetTWetBulbFromRelHum(t, rh / 100, stationPressureHpa * 100);
  } catch {
    return null;
  }
}
export function windChill(t, windMs) {
  if (!valid(t, windMs) || t > 10 || windMs <= 1.34) return null;
  const v = (windMs * 3.6) ** 0.16;
  return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v;
}
export function heatIndex(t, rh) {
  if (!valid(t, rh) || rh < 0 || rh > 100) return null;
  const f = t * 1.8 + 32;
  let h = 0.5 * (f + 61 + (f - 68) * 1.2 + rh * 0.094);
  if ((h + f) / 2 < 80) return null;
  h =
    -42.379 +
    2.04901523 * f +
    10.14333127 * rh -
    0.22475541 * f * rh -
    0.00683783 * f ** 2 -
    0.05481717 * rh ** 2 +
    0.00122874 * f ** 2 * rh +
    0.00085282 * f * rh ** 2 -
    0.00000199 * f ** 2 * rh ** 2;
  if (rh < 13 && f >= 80 && f <= 112) h -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(f - 95)) / 17);
  if (rh > 85 && f >= 80 && f <= 87) h += (((rh - 85) / 10) * (87 - f)) / 5;
  return (h - 32) / 1.8;
}
export function apparentTemperature(t, rh, windMs) {
  if (!valid(t, rh, windMs) || rh < 0 || rh > 100 || windMs < 0) return null;
  return t + 0.33 * ((rh / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t))) - 0.7 * windMs - 4;
}
export function humidex(t, dew) {
  if (!valid(t, dew) || t < 20 || dew < -100 || dew > t) return null;
  return t + (5 / 9) * (6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / (dew + 273.15))) - 10);
}
import { beaufort } from '../shared/wind.js';
export { beaufort };
export function vectorDirection(samples) {
  const good = samples.filter((x) => valid(x.speed, x.direction) && x.speed > 0);
  if (!good.length) return null;
  const x = good.reduce((sum, v) => sum + v.speed * Math.sin((v.direction * Math.PI) / 180), 0),
    y = good.reduce((sum, v) => sum + v.speed * Math.cos((v.direction * Math.PI) / 180), 0);
  if (Math.hypot(x, y) < 1e-8) return null;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}
export function derived(m) {
  const dew = dewPoint(m.temperatureC, m.humidityPct);
  return {
    dewPointC: dew,
    wetBulbC: wetBulb(m.temperatureC, m.humidityPct, m.stationPressureHpa),
    windChillC: windChill(m.temperatureC, m.windSpeedMs),
    heatIndexC: heatIndex(m.temperatureC, m.humidityPct),
    apparentTemperatureC: apparentTemperature(m.temperatureC, m.humidityPct, m.windSpeedMs),
    humidexC: humidex(m.temperatureC, dew),
    beaufort: beaufort(m.windSpeedMs),
    cloudBaseEstimateM: valid(m.temperatureC, dew) ? Math.max(0, (m.temperatureC - dew) * 125) : null,
  };
}
