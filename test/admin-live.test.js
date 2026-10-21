import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, observation } from './helpers.js';
import { ingest } from '../server/observations.js';
import { adminSnapshot } from '../server/admin-live.js';
import { dataStatus, freshnessThresholds } from '../shared/freshness.js';
import { recordDeviceHealth } from '../server/device-health.js';
test('admin retains last good values through outages, partial measurements and restart-independent reads with global/per-station ages', (t) => {
  const s = setup(t),
    station = s.store.stationList()[0].value;
  ingest(s.store, station.id, observation(station.id, s.now()));
  const first = adminSnapshot(s.store)[station.key];
  assert.equal(first.temp, 20);
  assert.equal(first.status, 'green');
  s.tick(3001);
  let current = adminSnapshot(s.store)[station.key];
  assert.equal(current.temp, 20);
  assert.equal(current.status, 'orange');
  s.tick(30000);
  current = adminSnapshot(s.store)[station.key];
  assert.equal(current.temp, 20);
  assert.equal(current.status, 'red');
  ingest(
    s.store,
    station.id,
    observation(station.id, s.now(), { sequence: 2, sensorContact: false, measurements: {} }),
  );
  assert.equal(adminSnapshot(s.store)[station.key].temp, 20);
  s.tick(1);
  ingest(
    s.store,
    station.id,
    observation(station.id, s.now(), { sequence: 3, measurements: { windSpeedMs: 7 } }),
  );
  current = adminSnapshot(s.store)[station.key];
  assert.equal(current.temp, 20);
  assert.equal(current.wlatest, 7);
  assert.ok(Date.parse(current.fields.temperatureC.at) < Date.parse(current.fields.windSpeedMs.at));
  const customized = { ...station, freshness: { warningSeconds: 1, downSeconds: 2 } };
  assert.equal(
    dataStatus(
      first.lastValidTime,
      s.now(),
      freshnessThresholds(s.store.current('gateway').value, customized),
    ),
    'red',
  );
  assert.equal(
    dataStatus(first.lastValidTime, Date.parse(first.lastValidTime) + 3000, {
      warningSeconds: 3,
      downSeconds: 30,
    }),
    'green',
  );
});
test('device health ignores stale retained online packets and replayed heartbeats, preserves last health on LWT and records new boot', (t) => {
  const s = setup(t),
    id = s.store.stationList()[0].value.id,
    bootId = '11111111-1111-4111-8111-111111111111';
  assert.equal(
    recordDeviceHealth(
      s.store,
      id,
      { online: true, bootId, heartbeatSequence: 1, freeHeapBytes: 100000 },
      { retained: true },
    ),
    false,
  );
  assert.equal(
    recordDeviceHealth(s.store, id, { online: true, bootId, heartbeatSequence: 1, freeHeapBytes: 100000 }),
    true,
  );
  s.tick(5000);
  assert.equal(
    recordDeviceHealth(s.store, id, { online: true, bootId, heartbeatSequence: 1, freeHeapBytes: 1 }),
    false,
  );
  recordDeviceHealth(s.store, id, { online: false });
  const row = s.store.db.prepare('SELECT payload FROM device_status WHERE station_id=?').get(id),
    health = JSON.parse(row.payload);
  assert.equal(health.freeHeapBytes, 100000);
  assert.equal(health.online, false);
  assert.equal(s.now() - health.lastContactAt, 5000);
});
