import { freshnessThresholds, dataStatus } from '../shared/freshness.js';
import { latest } from './observations.js';

export const displayFields = {
  temperatureC: 'temp',
  humidityPct: 'hum',
  pressureHpa: 'press',
  windSpeedMs: 'wlatest',
  windMeanMs: 'wspeed',
  windGustMs: 'wgust',
  windDirectionDeg: 'bearing',
  rainTodayMm: 'rfall',
  rainRateMmH: 'rrate',
  solarWm2: 'SolarRad',
  uvIndex: 'UV',
  dewPointC: 'dew',
  windChillC: 'wchill',
  heatIndexC: 'heatindex',
  apparentTemperatureC: 'apptemp',
  humidexC: 'humidex',
};
export function retainDisplay(store, stationId, body) {
  const row = store.db.prepare('SELECT payload FROM station_display WHERE station_id=?').get(stationId);
  const display = row ? JSON.parse(row.payload) : { fields: {}, lastValidTime: null, lastReceivedAt: null };
  if (!body.sensorContact) return;
  for (const [metric, value] of Object.entries({ ...body.measurements, ...body.derived })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const at = body.measurementTimes?.[metric] || body.observedAt;
    if (!display.fields[metric] || Date.parse(at) >= Date.parse(display.fields[metric].at))
      display.fields[metric] = { value, at };
  }
  if (!display.lastValidTime || Date.parse(body.observedAt) >= Date.parse(display.lastValidTime)) {
    display.lastValidTime = body.observedAt;
    display.lastReceivedAt = body.receivedAt;
  }
  store.db
    .prepare('INSERT OR REPLACE INTO station_display VALUES (?,?)')
    .run(stationId, JSON.stringify(display));
}
export function adminSnapshot(store) {
  const gateway = store.confirmedValue('gateway');
  return Object.fromEntries(
    store
      .stationList()
      .map((item) => store.confirmedValue(item.scope))
      .filter((s) => s.model !== 'Netatmo')
      .map((s) => {
        let row = store.db.prepare('SELECT payload FROM station_display WHERE station_id=?').get(s.id);
        // Seed upgraded installations from retained observations once, oldest to newest.
        if (!row && !store.readonly) {
          const rows = store.db
            .prepare('SELECT body FROM observations WHERE station_id=? ORDER BY observed_at DESC LIMIT 5000')
            .all(s.id);
          for (const prior of rows.reverse()) retainDisplay(store, s.id, JSON.parse(prior.body));
          row = store.db.prepare('SELECT payload FROM station_display WHERE station_id=?').get(s.id);
        }
        const display = row
          ? JSON.parse(row.payload)
          : { fields: {}, lastValidTime: null, lastReceivedAt: null };
        const thresholds = freshnessThresholds(gateway, s),
          result = {
            ...display,
            thresholds,
            status: dataStatus(display.lastValidTime, store.clock(), thresholds, s.enabled),
          };
        for (const [field, target] of Object.entries(displayFields))
          result[target] = display.fields[field]?.value ?? null;
        result.sensorContact = latest(store, s.id)?.sensorContact ?? false;
        return [s.key, result];
      }),
  );
}
