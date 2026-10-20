import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, observation } from './helpers.js';
import { ingest, latest, periodReport, legacy } from '../server/observations.js';
import { records, renderTemplate, climateText } from '../server/reports.js';
import { importHistory } from '../server/history-import.js';
import { rainWindow, rainDayWindow, rainStatistics } from '../server/rain-statistics.js';
import { mqttSubjectAltNames } from '../server/tls-identities.js';
import { validateScope } from '../server/schema.js';
import { DateTime } from 'luxon';
import { normalizeHistory } from '../server/history-normalizer.js';
import { rainCoverageComplete } from '../server/davis-iss.js';

function configureStation(store, station, patch) {
  const current = store.current(`station:${station.id}`),
    change = store.propose(current.scope, { ...current.value, ...patch }, current.revision, 'admin');
  store.begin(change.id, 'admin');
  store.health(change.id, true, { schema: 'ok' });
  store.confirm(change.id, 'admin');
}
test('calibration preserves raw values, applies only after confirmation, and quality rules can exclude a configured spike', (t) => {
  const s = setup(t),
    station = s.store.stationList()[0].value;
  const draft = s.store.propose(
    `station:${station.id}`,
    { ...station, calibration: { ...station.calibration, temperatureOffsetC: 2 } },
    1,
    'admin',
  );
  s.store.begin(draft.id, 'admin');
  ingest(s.store, station.id, observation(station.id, s.now()));
  assert.equal(latest(s.store, station.id).measurements.temperatureC, 20);
  s.store.health(draft.id, true, { schema: 'ok' });
  s.store.confirm(draft.id, 'admin');
  s.tick(1000);
  ingest(s.store, station.id, observation(station.id, s.now(), { sequence: 2 }));
  const calibrated = latest(s.store, station.id);
  assert.equal(calibrated.rawMeasurements.temperatureC, 20);
  assert.equal(calibrated.measurements.temperatureC, 22);
  configureStation(s.store, station, {
    qualityRules: [{ metric: 'temperatureC', maximumChangePerMinute: 1, stuckSeconds: 0, action: 'missing' }],
  });
  s.tick(1000);
  ingest(s.store, station.id, observation(station.id, s.now(), { sequence: 3 }));
  s.tick(1000);
  ingest(
    s.store,
    station.id,
    observation(station.id, s.now(), { sequence: 4, measurements: { temperatureC: 25, humidityPct: 50 } }),
  );
  const excluded = latest(s.store, station.id);
  assert.equal(excluded.rawMeasurements.temperatureC, 25);
  assert.equal(excluded.measurements.temperatureC, null);
  assert.equal(excluded.derived.dewPointC, null);
  assert.equal(excluded.quality.flags[0].reason, 'rate-of-change');
});
test('history previews are bound to actor, exact data and deadline; historical imports do not enqueue external SQL writes', (t) => {
  const s = setup(t),
    stationId = s.store.stationList()[0].value.id;
  configureStation(s.store, s.store.confirmedValue(`station:${stationId}`), {
    calibration: { ...s.store.confirmedValue(`station:${stationId}`).calibration, temperatureOffsetC: 2 },
  });
  const observations = [observation(stationId, Date.UTC(2020, 0, 1, 12))],
    batch = { format: 'wg-history-1', stationId, observations, dryRun: true };
  const preview = importHistory(s.store, batch, 'admin');
  assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 0);
  assert.throws(
    () => importHistory(s.store, { ...batch, dryRun: false, previewId: preview.previewId }, 'other'),
    /nytt/,
  );
  const result = importHistory(s.store, { ...batch, dryRun: false, previewId: preview.previewId }, 'admin');
  assert.equal(result.inserted, 1);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM database_outbox').get().n, 0);
  assert.equal(records(s.store, stationId).metrics.temperatureC.minimum, 20);
  assert.equal(latest(s.store, stationId).imported.calibration, 'source-values');
  assert.throws(
    () => importHistory(s.store, { ...batch, dryRun: false, previewId: preview.previewId }, 'admin'),
    /nytt/,
  );
  const expired = importHistory(s.store, batch, 'admin');
  s.tick(300001);
  assert.throws(
    () => importHistory(s.store, { ...batch, dryRun: false, previewId: expired.previewId }, 'admin'),
    /nytt/,
  );
});
test('records retain the actual late observation time; reports distinguish absent days and templates escape data without executing code', (t) => {
  const s = setup(t),
    station = s.store.stationList()[0].value,
    start = s.now();
  ingest(s.store, station.id, observation(station.id, start));
  s.tick(300000);
  ingest(
    s.store,
    station.id,
    observation(station.id, s.now(), { sequence: 2, measurements: { temperatureC: 25 } }),
  );
  ingest(
    s.store,
    station.id,
    observation(station.id, start + 120000, { sequence: 3, measurements: { temperatureC: 10 } }),
  );
  assert.equal(
    records(s.store, station.id).metrics.temperatureC.minAt,
    new Date(start + 120000).toISOString(),
  );
  const report = periodReport(s.store, station.id, '2026-10');
  assert.equal(Object.keys(report.days).length, 31);
  assert.equal(report.days['2026-10-01'].climate.means.temperatureC, null);
  assert.match(climateText(station, report), /2026-10-01\s+--/);
  assert.equal(
    renderTemplate(
      '{{station.name}} {{weather.temp}}',
      { station: { name: '<script>' }, weather: { temp: 5 } },
      { html: true },
    ),
    '&lt;script&gt; 5',
  );
  assert.throws(() => renderTemplate('{{station.constructor}}', { station }), /Ukjent/);
  assert.throws(
    () =>
      validateScope(`station:${station.id}`, {
        ...station,
        templates: [{ name: station.exportName, content: 'x' }],
      }),
    /Filnavn/,
  );
  assert.equal(legacy(s.store, station).temp, '25.0');
});
test('rain intervals never distribute ambiguous rain across a window boundary; reported rain days follow Oslo DST', (t) => {
  const s = setup(t),
    station = s.store.stationList()[0].value,
    start = s.now();
  const insert = s.store.db.prepare('INSERT INTO rain_increments VALUES (?,?,?,?,?)');
  insert.run(station.id, start, start + 1800000, 1, 1);
  insert.run(station.id, start + 1800000, start + 3600000, 2, 1);
  assert.equal(rainWindow(s.store, station.id, start, start + 3600000).totalMm, 3);
  assert.equal(rainWindow(s.store, station.id, start + 900000, start + 2700000).totalMm, null);
  const spring = rainDayWindow('2026-03-28', 7),
    fall = rainDayWindow('2026-10-24', 7);
  assert.equal((spring[1] - spring[0]) / 3600000, 23);
  assert.equal((fall[1] - fall[0]) / 3600000, 25);
  const state = s.store.db.prepare('INSERT INTO rain_state VALUES (?,?,?,?,?,?,?)');
  for (const [date, rain] of [
    ['2026-10-15', 0],
    ['2026-10-16', 0],
    ['2026-10-17', 1],
    ['2026-10-18', 2],
  ])
    state.run(
      station.id,
      date,
      DateTime.fromISO(date, { zone: 'Europe/Oslo' }).plus({ days: 1 }).toMillis() - 1000,
      0,
      'mm',
      rain,
      0,
    );
  const stats = rainStatistics(s.store, station, '2026-10-15', '2026-10-18');
  assert.equal(stats.longestDryDays, 2);
  assert.equal(stats.longestWetDays, 2);
});
test('history normalization rejects station mismatches and DST ambiguity instead of assigning the wrong station or time', () => {
  const row = {
    station_id: 'skodje',
    date: '2026-10-25',
    time: '02:30:00',
    temperature: 10,
    average_windspeed: 36,
  };
  const options = { format: 'wx-data', windUnit: 'kmh', stationKey: 'skodje' };
  assert.throws(() => normalizeHistory(row, '775147d2-71e6-480d-8827-392ace169300', options), /Tvetydig/);
  const earlier = normalizeHistory(row, '775147d2-71e6-480d-8827-392ace169300', {
    ...options,
    fold: 'earlier',
  });
  const later = normalizeHistory(row, '775147d2-71e6-480d-8827-392ace169300', { ...options, fold: 'later' });
  assert.equal(Date.parse(later.observedAt) - Date.parse(earlier.observedAt), 3600000);
  assert.equal(earlier.measurements.windMeanMs, 10);
  assert.equal(earlier.measurements.windSpeedMs, undefined);
  assert.throws(
    () => normalizeHistory({ ...row, station_id: 'vatne' }, earlier.stationId, options),
    /annen stasjon/,
  );
  assert.throws(
    () => normalizeHistory({ ...row, date: '2026-03-29' }, earlier.stationId, options),
    /finnes ikke/,
  );
});
test('daily rain is incomplete after missing end-of-day readings, including non-ISS counters', () => {
  const start = DateTime.fromISO('2026-10-18', { zone: 'Europe/Oslo' }).toMillis(),
    end = start + 86400000;
  assert.equal(
    rainCoverageComplete({ day: '2026-10-18', unit: 'mm', last_at: start + 43200000 }, 0.2, end + 1000),
    false,
  );
  assert.equal(
    rainCoverageComplete({ day: '2026-10-18', unit: 'mm', last_at: end - 1000 }, 0.2, end + 1000),
    true,
  );
  assert.equal(
    rainCoverageComplete({ day: '2026-10-18', unit: 'mm', last_at: end + 1000 }, 0.2, end + 1000),
    false,
  );
});
test('MQTT TLS identities use IP SAN for IPv4/IPv6, preserve DNS names and reject extension injection', () => {
  assert.equal(
    mqttSubjectAltNames('127.0.0.1', '192.168.1.5,wg-api.example.test,127.0.0.1'),
    'IP:127.0.0.1,DNS:broker,IP:192.168.1.5,DNS:wg-api.example.test',
  );
  assert.equal(mqttSubjectAltNames('[::1]'), 'IP:::1,DNS:broker');
  assert.throws(() => mqttSubjectAltNames('valid.example', 'bad\nCA:TRUE'), /Ugyldig/);
});
