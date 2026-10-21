import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, observation } from './helpers.js';
import { ingest } from '../server/observations.js';
import { adminSnapshot } from '../server/admin-live.js';
import { dataStatus, freshnessThresholds } from '../shared/freshness.js';
import { recordDeviceHealth, deviceHealthSchema } from '../server/device-health.js';
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

test('radio diagnostics persist with separate ISS and Wi-Fi signals and reject invalid channel/counter values', (t) => {
  const s = setup(t),
    station = s.store.stationList()[0].value;
  const radio = {
    state: 'tracking',
    transmitterId: 1,
    channel: 5,
    lastReceivedChannel: 4,
    rssiDbm: -63,
    packetsReceived: 480,
    missedPackets: 2,
    crcErrors: 1,
    fifoOverruns: 0,
    spiErrors: 0,
    foreignPackets: 8,
    repeaterPackets: 0,
    resyncs: 0,
    stalePackets: 0,
    maxPollGapMs: 8,
    queuedPackets: 0,
    queueDropped: 0,
    lastPacketAgeMs: 180,
    rssiThresholdDbm: -85,
    backgroundRssiDbm: -103,
    afcHz: -244,
    signalTimeouts: 4,
    pllTimeouts: 0,
    lastRejected: {
      reason: 'crc',
      packetHex: '8004700f99009110ffff',
      channel: 2,
      rssiDbm: -100,
      afcHz: 1245,
      ageMs: 700,
    },
  };
  recordDeviceHealth(s.store, station.id, { online: true, wifiRssiDbm: -45, mqttInputDropped: 0, radio });
  const health = JSON.parse(
    s.store.db.prepare('SELECT payload FROM device_status WHERE station_id=?').get(station.id).payload,
  );
  assert.deepEqual(health.radio, radio);
  assert.equal(health.wifiRssiDbm, -45);
  assert.equal(health.mqttInputDropped, 0);
  for (const invalid of [
    { channel: 6 },
    { transmitterId: 0 },
    { crcErrors: -1 },
    { state: 'ready' },
    { rssiThresholdDbm: -121 },
    { lastRejected: { ...radio.lastRejected, packetHex: 'invalid' } },
  ])
    assert.equal(
      deviceHealthSchema.safeParse({ online: true, radio: { ...radio, ...invalid } }).success,
      false,
    );
  recordDeviceHealth(s.store, station.id, {
    online: true,
    rs485: { protocol: 'davis-iss-rs485-v1', checksum: 'none', baud: 4800, framesReceived: 3 },
  });
  const switched = JSON.parse(
    s.store.db.prepare('SELECT payload FROM device_status WHERE station_id=?').get(station.id).payload,
  );
  assert.equal(switched.radio, undefined);
  assert.equal(switched.rs485.framesReceived, 3);
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
