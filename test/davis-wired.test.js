import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, observation } from './helpers.js';
import { decodeWiredIss } from '../server/davis-iss.js';
import { ingest, latest, legacy } from '../server/observations.js';
import { deviceProfile } from '../shared/device-hardware.js';
import { databaseSchema, telemetrySchema, deviceSchema } from '../server/schema.js';
import { publicProjection } from '../server/public-projection.js';
import { Store, hash } from '../server/store.js';
import { handleAck, deviceHealth } from '../server/worker.js';

function fixture(t) {
  const s = setup(t),
    station = s.store.stationList().find((s) => s.value.model === 'Davis Vantage Pro2').value;
  const device = deviceSchema.parse(
    deviceProfile(s.store.confirmedValue(`device:${station.id}`), 'davis-iss-rs485'),
  );
  s.store.db
    .prepare('UPDATE configuration SET payload=? WHERE scope=?')
    .run(JSON.stringify(device), `device:${station.id}`);
  return { ...s, station, device };
}
function receive(s, sequence, hex, overrides = {}) {
  return ingest(
    s.store,
    s.station.id,
    observation(s.station.id, s.now(), {
      sequence,
      configurationHash: hash(s.device),
      measurements: { pressureHpa: 999 },
      source: { protocol: 'davis-iss-rs485', packet: Buffer.from(hex, 'hex').toString('base64') },
      ...overrides,
    }),
  );
}
test('native six-byte ISS uses documented fields, signed temperature, missing sensors and bucket size without manufacturing CRC', () => {
  const decode = (hex) => decodeWiredIss(Buffer.from(hex, 'hex'), 'Davis Vantage Pro2', 0.2);
  const t = decode('8004700f9900');
  assert.equal(t.measurements.temperatureC, (3993 / 160 - 32) / 1.8);
  assert.equal(t.measurements.windSpeedMs, 4 * 0.44704);
  assert.equal(decode('a00652833800').measurements.humidityPct, 89.9);
  assert.equal(decode('800470ff6000').measurements.temperatureC, (-1 - 32) / 1.8);
  assert.equal(decode('400470ffff00').measurements.uvIndex, null);
  assert.equal(decode('600470ffff00').measurements.solarWm2, null);
  assert.equal(decode('500470640000').measurements.rainRateMmH, 7.2);
  assert.equal(decode('500470644000').measurements.rainRateMmH, 115.2);
  assert.equal(decode('900470140020').measurements.windGustMs, 20 * 0.44704);
  assert.equal(decode('e004707f0000').rawFields.rainCounterTips, 127);
  for (const hex of ['8004700f99', '8004700f990000', '3004700f9900']) assert.throws(() => decode(hex));
  assert.throws(() => decodeWiredIss(Buffer.from('8004700f9900', 'hex'), 'Davis Vantage Vue', 0.2));
  const message = observation('775147d2-71e6-480d-8827-392ace169301', Date.now(), {
    source: { protocol: 'davis-iss-rs485', packet: Buffer.from('8004700f9900', 'hex').toString('base64') },
  });
  assert.ok(telemetrySchema.safeParse(message).success);
  assert.equal(
    telemetrySchema.safeParse({ ...message, source: { ...message.source, rssiDbm: -20 } }).success,
    false,
  );
});
test('wired ISS is decoded into retained weather, derived values, SQL queue and public projection with explicit lack of bus checksum', (t) => {
  const s = fixture(t),
    scope = `database:${s.station.id}`;
  const target = databaseSchema.parse({
    ...s.store.confirmedValue(scope),
    enabled: true,
    host: '127.0.0.1',
    database: 'wg_dev_wire',
    user: 'test',
    intervalSeconds: 1,
  });
  s.store.db.prepare('UPDATE configuration SET payload=? WHERE scope=?').run(JSON.stringify(target), scope);
  receive(s, 1, '8004700f9900');
  s.tick(2500);
  receive(s, 2, 'a00652833800');
  const body = latest(s.store, s.station.id);
  assert.equal(body.measurements.humidityPct, 89.9);
  assert.ok(Number.isFinite(body.measurements.temperatureC));
  assert.ok(Number.isFinite(body.derived.dewPointC));
  assert.equal(body.measurements.pressureHpa, undefined);
  assert.equal(body.quality.linkChecksum, 'none');
  assert.equal(body.iss.transport, 'rs485');
  assert.equal(Buffer.from(body.source.packet, 'base64').length, 6);
  const rows = s.store.db
    .prepare('SELECT row_json FROM database_outbox WHERE station_id=? ORDER BY observed_at')
    .all(s.station.id);
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[1].row_json).outdoor_humidity, 89.9);
  assert.equal(JSON.parse(rows[1].row_json).barometer, null);
  const projection = publicProjection(s.store);
  try {
    projection.sync();
    const value = legacy(projection.store, s.station);
    assert.notEqual(value.temp, '');
    assert.notEqual(value.hum, '');
    assert.equal(value.press, '');
    s.tick(60001);
    assert.equal(legacy(projection.store, s.station).temp, '');
  } finally {
    projection.close();
  }
  assert.throws(() =>
    receive({ ...s, station: { ...s.station, id: s.store.stationList()[0].value.id } }, 3, '8004700f9900'),
  );
});
test('wired rain counter wraps once, survives restart and ignores duplicates, old packets and ambiguous outages', (t) => {
  const s = fixture(t);
  receive(s, 1, 'e004707f0000');
  s.tick(10000);
  receive(s, 2, 'e00470000000');
  assert.equal(receive(s, 2, 'e00470000000'), false);
  const restarted = new Store({ root: s.store.root, environment: 'test', clock: s.now });
  try {
    s.tick(10000);
    receive({ ...s, store: restarted }, 3, 'e00470010000');
    assert.equal(
      restarted.db.prepare('SELECT total_mm FROM rain_state WHERE station_id=?').get(s.station.id).total_mm,
      0.4,
    );
    receive({ ...s, store: restarted }, 4, 'e00470640000', {
      observedAt: new Date(s.now() - 5000).toISOString(),
    });
    assert.equal(
      restarted.db.prepare('SELECT counter FROM iss_rain WHERE station_id=?').get(s.station.id).counter,
      1,
    );
    s.tick(60000);
    receive({ ...s, store: restarted }, 5, 'e00470280000');
    assert.equal(
      restarted.db.prepare('SELECT total_mm FROM rain_state WHERE station_id=?').get(s.station.id).total_mm,
      0.4,
    );
    assert.equal(latest(restarted, s.station.id).quality.rainCounterGap, true);
  } finally {
    restarted.close();
  }
});
test('wired configuration trials require ACK and real six-byte telemetry; commit applies and timeout restores the last configuration', (t) => {
  const s = fixture(t),
    record = s.store.current(`device:${s.station.id}`),
    candidate = { ...record.value, mqttPort: 8884 };
  const trial = s.store.propose(record.scope, candidate, record.revision, 'admin');
  s.store.begin(trial.id, 'admin');
  const command = s.store.db
    .prepare("SELECT * FROM commands WHERE change_id=? AND kind='test_config'")
    .get(trial.id);
  handleAck(s.store, s.station.id, {
    version: 1,
    stationId: s.station.id,
    commandId: command.id,
    status: 'testing',
    configurationHash: hash(candidate),
  });
  assert.throws(() => s.store.confirm(trial.id, 'admin'));
  receive(s, 1, '8004700f9900', { configurationHash: hash(candidate) });
  assert.equal(deviceHealth(s.store, s.station.id), true);
  s.store.confirm(trial.id, 'admin');
  const commit = s.store.db
    .prepare("SELECT * FROM commands WHERE change_id=? AND kind='commit_config'")
    .get(trial.id);
  handleAck(s.store, s.station.id, {
    version: 1,
    stationId: s.station.id,
    commandId: commit.id,
    status: 'applied',
    configurationHash: hash(candidate),
  });
  assert.deepEqual(s.store.confirmedValue(record.scope), candidate);
  const next = s.store.current(record.scope),
    expired = s.store.propose(next.scope, { ...next.value, mqttPort: 9000 }, next.revision, 'admin');
  s.store.begin(expired.id, 'admin');
  s.tick(300001);
  s.store.sweep();
  assert.equal(s.store.getChange(expired.id).state, 'rolled_back');
  assert.deepEqual(s.store.confirmedValue(record.scope), candidate);
});
