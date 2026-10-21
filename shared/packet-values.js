import { compassPoints } from './wind.js';

// Display the gateway's saved interpretation; never decode historic bytes using
// today's calibration or present retained values as new packet measurements.
export const packetWeatherFields = {
  temperatureC: ['Temperatur', '°C'],
  humidityPct: ['Luftfuktighet', '%'],
  windSpeedMs: ['Vindhastighet', 'm/s'],
  windDirectionDeg: ['Vind fra', '°'],
  windGustMs: ['Vindkast', 'm/s'],
  windMeanMs: ['Middelvind', 'm/s'],
  pressureHpa: ['Lufttrykk', 'hPa'],
  stationPressureHpa: ['Stasjonstrykk', 'hPa'],
  rainRateMmH: ['Regnrate', 'mm/t'],
  rainTodayMm: ['Nedbør i dag', 'mm'],
  rainLastHourMm: ['Nedbør siste time', 'mm'],
  rainLast24HoursMm: ['Nedbør siste døgn', 'mm'],
  rainLast15MinutesMm: ['Nedbør siste kvarter', 'mm'],
  rainCounterMm: ['Regnteller', 'mm'],
  rainCounterTips: ['Regnteller', 'vipp'],
  solarWm2: ['Solstråling', 'W/m²'],
  uvIndex: ['UV-indeks', ''],
  indoorTemperatureC: ['Innetemperatur', '°C'],
  indoorHumidityPct: ['Innendørs luftfuktighet', '%'],
  soilTemperatureC: ['Jordtemperatur', '°C'],
  beaufort: ['Beaufort', ''],
  dewPointC: ['Duggpunkt', '°C'],
  wetBulbC: ['Våttemperatur', '°C'],
  windChillC: ['Vindavkjøling', '°C'],
  heatIndexC: ['Varmeindeks', '°C'],
  apparentTemperatureC: ['Følt temperatur', '°C'],
  humidexC: ['Humidex', ''],
  cloudBaseEstimateM: ['Anslått skybase', 'm'],
};
const issCalculated = new Set([
  'windMeanMs',
  'rainTodayMm',
  'rainLastHourMm',
  'rainLast24HoursMm',
  'rainLast15MinutesMm',
]);
export function packetKind(packet) {
  if (packet.protocol === 'davis-loop') return 'Samlet værpakke';
  return (
    {
      4: 'UV',
      5: 'Regnrate',
      6: 'Solstråling',
      8: 'Temperatur',
      9: 'Vindkast',
      10: 'Luftfuktighet',
      14: 'Regnteller',
    }[packet.type] || 'Vind og øvrige sensordata'
  );
}
export function packetReadings(packet) {
  if (packet.status !== 'accepted') return [];
  const measurements = packet.measurements || {},
    raw = packet.rawMeasurements || {},
    derived = packet.derived || {};
  const iss = packet.protocol?.startsWith('davis-iss');
  return Object.entries(packetWeatherFields).flatMap(([metric, [label, unit]]) => {
    const counter =
      metric === 'rainCounterTips' && packet.rainCounterTips !== null && packet.rainCounterTips !== undefined;
    if (!counter && !Object.hasOwn(measurements, metric) && !Object.hasOwn(derived, metric)) return [];
    const calculated = Object.hasOwn(derived, metric) || (iss && issCalculated.has(metric));
    const at = packet.measurementTimes?.[metric] || packet.observedAt;
    const fresh =
      counter ||
      (Array.isArray(packet.freshFields)
        ? packet.freshFields.includes(metric)
        : packet.protocol === 'davis-loop' ||
          (packet.measurementTimes?.[metric] === packet.observedAt && !!packet.observedAt));
    return [
      {
        metric,
        label,
        unit,
        value: counter
          ? packet.rainCounterTips
          : Object.hasOwn(derived, metric)
            ? derived[metric]
            : measurements[metric],
        rawValue: calculated ? null : (raw[metric] ?? null),
        at,
        source: calculated ? 'calculated' : fresh ? 'packet' : 'retained',
      },
    ];
  });
}
export function readingValue(reading, value = reading.value) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return reading.source === 'calculated' ? 'Ikke beregnet' : 'Mangler';
  const formatted = value.toLocaleString('nb-NO', { maximumFractionDigits: 2 });
  if (reading.metric === 'windDirectionDeg')
    return `${compassPoints[Math.round((((value % 360) + 360) % 360) / 45) % 8]} (${formatted}°)`;
  return `${formatted}${reading.unit ? ` ${reading.unit}` : ''}`;
}
