import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, observation } from './helpers.js';
import { ingest, snapshot, history, dayRange, exportStation } from '../server/observations.js';
import { handleMessage } from '../server/worker.js';

test('MQTT-inntak, idempotens, legacy-felt og atomisk eksport', (t) => {
  const { store, now } = setup(t),
    station = store.stationList()[0].value,
    message = observation(station.id, now()),
    topic = `wg/v1/test/stations/${station.id}/telemetry`;
  assert.equal(handleMessage(store, topic, Buffer.from(JSON.stringify(message))), true);
  assert.equal(ingest(store, station.id, message), false);
  const s = snapshot(store)[station.key];
  assert.equal(s.temp, '20.0');
  assert.equal(s.wlatest, '5.0');
  assert.equal(s.wspeed, '4.0');
  assert.equal(s.rfall, '3.4');
  assert.equal(s.timeUTC, '2026,10,19,10,0,0');
  assert.equal(s.status, 'green');
  const file = JSON.parse(readFileSync(exportStation(store, station), 'utf8'));
  assert.equal(file.temp, '20.0');
  assert.equal(file.status, undefined);
  assert.equal(file.SensorContactLost, '0');
});
test('feil miljø, forfalsket stasjon, oversize og fremtidig tid avvises', (t) => {
  const { store, now } = setup(t),
    stations = store.stationList(),
    message = observation(stations[0].value.id, now());
  assert.throws(() =>
    handleMessage(
      store,
      `wg/v1/production/stations/${message.stationId}/telemetry`,
      Buffer.from(JSON.stringify(message)),
    ),
  );
  assert.throws(() => ingest(store, stations[1].value.id, message));
  assert.throws(() =>
    ingest(store, message.stationId, { ...message, observedAt: new Date(now() + 61000).toISOString() }),
  );
  assert.throws(() => handleMessage(store, 'invalid', Buffer.alloc(17000)));
});
test('vindstille bevares; manglende verdier er ikke nullmålinger', (t) => {
  const { store, now } = setup(t),
    station = store.stationList()[0].value;
  ingest(
    store,
    station.id,
    observation(station.id, now(), { measurements: { windSpeedMs: 0, temperatureC: null } }),
  );
  const s = snapshot(store)[station.key];
  assert.equal(s.wlatest, '0.0');
  assert.equal(s.temp, '');
  assert.equal(s.dew, '');
});
test('sen ankomst overskriver ikke nyere sanntidsmåling', (t) => {
  const { store, now } = setup(t),
    station = store.stationList()[0].value;
  ingest(store, station.id, observation(station.id, now()));
  ingest(
    store,
    station.id,
    observation(station.id, now() - 5000, { sequence: 2, measurements: { temperatureC: 1 } }),
  );
  assert.equal(snapshot(store)[station.key].temp, '20.0');
});
test('sensorbortfall vises og brukes ikke i klimastatistikk', (t) => {
  const { store, now } = setup(t),
    station = store.stationList()[0].value;
  ingest(store, station.id, observation(station.id, now(), { sensorContact: false }));
  assert.equal(snapshot(store)[station.key].status, 'red');
  assert.equal(history(store, station.id, '2026-10-19').summary.samples, 0);
});
test('lokalt døgn er 23/25 timer ved sommertidsendring', () => {
  const spring = dayRange('2026-03-29'),
    fall = dayRange('2026-10-25');
  assert.equal((spring[1] - spring[0]) / 3600000, 23);
  assert.equal((fall[1] - fall[0]) / 3600000, 25);
  assert.throws(() => dayRange('2026-02-30'));
});
test('historikk bevarer begge timer med lik lokal klokketid ved høstskifte', (t) => {
  const { store, tick } = setup(t),
    station = store.stationList()[0].value;
  tick(Date.UTC(2026, 9, 25, 3) - store.clock());
  ingest(store, station.id, observation(station.id, Date.UTC(2026, 9, 25, 0, 30)));
  ingest(store, station.id, observation(station.id, Date.UTC(2026, 9, 25, 1, 30), { sequence: 2 }));
  assert.equal(history(store, station.id, '2026-10-25').hourly.length, 2);
});
