import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, observation } from './helpers.js';
import { crcCcitt } from '../server/davis.js';
import { decodeIss } from '../server/davis-iss.js';
import { ingest, latest, legacy, periodReport } from '../server/observations.js';
import { radioDeviceSchema } from '../server/schema.js';
import { Store, hash } from '../server/store.js';
import { handleAck, deviceHealth } from '../server/worker.js';
import { publicProjection } from '../server/public-projection.js';
import { dayResponse } from '../server/legacy-sockets.js';

function frame(type, a = 0, b = 0, wireId = 0) {
  const bytes = Buffer.from([type * 16 + wireId, 4, 128, a, b, 0, 0, 0, 255, 255]);
  bytes.writeUInt16BE(crcCcitt(bytes.subarray(0, 6)), 6);
  return bytes;
}
function receive(store, now, sequence, packet, overrides = {}) {
  const stationId = store.stationList()[0].value.id;
  return ingest(
    store,
    stationId,
    observation(stationId, now(), {
      sequence,
      measurements: { pressureHpa: 999 },
      source: { protocol: 'davis-iss', packet: packet.toString('base64'), channel: 0, rssiDbm: -77 },
      ...overrides,
    }),
  );
}

test('ISS decodes published captured temperature and humidity frames, not synthetic LOOP packets', () => {
  const temperature = decodeIss(Buffer.from('8004700f99009111ffff', 'hex'), 'Davis Vantage Vue', 0.2);
  assert.ok(Math.abs(temperature.measurements.temperatureC - (3993 / 160 - 32) / 1.8) < 1e-10);
  const humidity = decodeIss(Buffer.from('a006528338005ac8ffff', 'hex'), 'Davis Vantage Pro2', 0.2);
  assert.equal(humidity.measurements.humidityPct, 89.9);
  assert.equal(humidity.transmitterId, 1);
  assert.equal(humidity.batteryLow, false);
  assert.equal(humidity.measurements.pressureHpa, undefined);
});
test('ISS rejects corruption, wrong size and repeater frames; ID and battery bits are independent', () => {
  const packet = frame(8, 0x1f, 0x40, 15);
  const decoded = decodeIss(packet, 'Davis Vantage Vue', 0.2);
  assert.equal(decoded.transmitterId, 8);
  assert.equal(decoded.batteryLow, true);
  packet[1] ^= 1;
  assert.throws(() => decodeIss(packet, 'Davis Vantage Vue', 0.2));
  assert.throws(() => decodeIss(packet.subarray(0, 8), 'Davis Vantage Vue', 0.2));
  const repeated = frame(8);
  repeated[9] = 0;
  assert.throws(() => decodeIss(repeated, 'Davis Vantage Vue', 0.2));
});
test('ISS preserves missing sensors and signed temperatures; wind direction follows selected model', () => {
  assert.equal(
    decodeIss(frame(8, 0xff, 0x60), 'Davis Vantage Vue', 0.2).measurements.temperatureC,
    (-1 - 32) / 1.8,
  );
  assert.equal(decodeIss(frame(8, 0x7f, 0xff), 'Davis Vantage Vue', 0.2).measurements.temperatureC, null);
  assert.equal(decodeIss(frame(6, 255), 'Davis Vantage Pro2', 0.2).measurements.solarWm2, null);
  assert.equal(decodeIss(frame(4, 255), 'Davis Vantage Pro2', 0.2).measurements.uvIndex, null);
  assert.notEqual(
    decodeIss(frame(2), 'Davis Vantage Vue', 0.2).measurements.windDirectionDeg,
    decodeIss(frame(2), 'Davis Vantage Pro2', 0.2).measurements.windDirectionDeg,
  );
});
test('ISS rain rate uses configured bucket size and rejects a zero interval', () => {
  assert.equal(decodeIss(frame(5, 100, 0), 'Davis Vantage Vue', 0.2).measurements.rainRateMmH, 7.2);
  assert.equal(decodeIss(frame(5, 100, 0), 'Davis Vantage Vue', 0.254).measurements.rainRateMmH, 9.144);
  assert.equal(decodeIss(frame(5, 100, 0x40), 'Davis Vantage Vue', 0.2).measurements.rainRateMmH, 115.2);
  assert.equal(decodeIss(frame(5, 255), 'Davis Vantage Vue', 0.2).measurements.rainRateMmH, 0);
  assert.equal(decodeIss(frame(5, 0), 'Davis Vantage Vue', 0.2).measurements.rainRateMmH, null);
});
test('ISS partial measurements retain individual times, expire, and never manufacture pressure', (t) => {
  const { store, now, tick } = setup(t),
    id = store.stationList()[0].value.id;
  receive(store, now, 1, frame(8, 0x1f, 0x40));
  const at = latest(store, id).observedAt;
  tick(10000);
  receive(store, now, 2, frame(10, 0xf4, 0x10));
  assert.equal(latest(store, id).measurementTimes.temperatureC, at);
  assert.equal(latest(store, id).measurements.humidityPct, 50);
  assert.equal(latest(store, id).measurements.pressureHpa, undefined);
  assert.equal(legacy(store, store.current(`station:${id}`).value).press, '');
  tick(51000);
  receive(store, now, 3, frame(2));
  assert.equal(latest(store, id).measurements.temperatureC, null);
  assert.equal(latest(store, id).measurements.humidityPct, 50);
  const samples = store.db
    .prepare("SELECT samples FROM rollups WHERE station_id=? AND metric='temperatureC' AND length(period)=10")
    .get(id);
  assert.equal(samples.samples, 1, 'held readings must not create more climate samples');
});
test('ISS sender-ID mismatch fails without storing data; new ESP boot drops held sensor values', (t) => {
  const { store, now, tick } = setup(t),
    id = store.stationList()[0].value.id;
  assert.throws(() => receive(store, now, 1, frame(8, 0x1f, 0x40, 1)));
  assert.equal(latest(store, id), null);
  receive(store, now, 1, frame(8, 0x1f, 0x40));
  tick(2500);
  receive(store, now, 2, frame(2), { bootId: '402500fa-a03b-4dcf-af73-11109f9b8330' });
  assert.equal(latest(store, id).measurements.temperatureC, undefined);
});
test('ISS seven-bit rain counter wraps once, is idempotent, and rejects late/gapped inflation', (t) => {
  const { store, now, tick } = setup(t),
    id = store.stationList()[0].value.id;
  receive(store, now, 1, frame(14, 127));
  tick(10000);
  receive(store, now, 2, frame(14, 0));
  assert.equal(receive(store, now, 2, frame(14, 0)), false);
  assert.equal(store.db.prepare('SELECT total_mm FROM rain_state').get().total_mm, 0.2);
  receive(store, () => now() - 5000, 3, frame(14, 100));
  assert.equal(store.db.prepare('SELECT counter FROM iss_rain').get().counter, 0);
  tick(60000);
  receive(store, now, 4, frame(14, 40));
  assert.equal(store.db.prepare('SELECT total_mm FROM rain_state').get().total_mm, 0.2);
  assert.equal(latest(store, id).quality.rainCounterGap, true);
  assert.equal(legacy(store, store.current(`station:${id}`).value).rfall, '');
  const report = periodReport(store, id, '2026-10').days['2026-10-19'];
  assert.equal(report.rainfallMm, null);
  assert.equal(report.rainfallObservedMm, 0.2);
});
test('ISS rain continuity survives worker restart and crosses local midnight without adding old tips', (t) => {
  const { store, now, tick } = setup(t),
    id = store.stationList()[0].value.id;
  tick(Date.UTC(2026, 9, 19, 21, 59, 55) - now());
  receive(store, now, 1, frame(14, 127));
  const restarted = new Store({ root: store.root, environment: 'test', clock: now });
  try {
    tick(10000);
    receive(restarted, now, 2, frame(14, 0));
    const day = restarted.db.prepare("SELECT * FROM rain_state WHERE day='2026-10-20'").get();
    assert.equal(day.total_mm, 0.2);
    assert.equal(day.unit, 'iss-tips');
    assert.equal(legacy(restarted, store.current(`station:${id}`).value).rfall, '0.2');
    tick(60000);
    assert.equal(legacy(restarted, store.current(`station:${id}`).value).rfall, '');
    assert.equal(periodReport(restarted, id, '2026-10').days['2026-10-20'].rainfallComplete, false);
  } finally {
    restarted.close();
  }
});
test('radio configuration rejects duplicate, strapping and flash pins and unsupported bands', (t) => {
  const { store } = setup(t),
    config = store.configurations('device:')[0].value;
  assert.equal(radioDeviceSchema.parse(config).radioBand, 'EU868');
  for (const edit of [
    { spiSck: 5 },
    { spiMiso: 6 },
    { radioCs: config.spiMosi },
    { transmitterId: 0 },
    { transmitterId: 9 },
    { radioBand: 'US915' },
  ])
    assert.equal(radioDeviceSchema.safeParse({ ...config, ...edit }).success, false);
});

test('radio trial needs candidate ACK plus a valid frame from the selected ISS before confirmation', (t) => {
  const { store, now } = setup(t),
    device = store.configurations('device:')[0];
  const change = store.propose(
    device.scope,
    { ...device.value, transmitterId: 2 },
    device.revision,
    'test-user',
  );
  store.begin(change.id, 'test-user');
  const command = store.db.prepare("SELECT * FROM commands WHERE kind='test_config'").get();
  handleAck(store, device.value.stationId, {
    version: 1,
    stationId: device.value.stationId,
    commandId: command.id,
    status: 'testing',
    configurationHash: hash(change.candidate),
  });
  assert.throws(() => receive(store, now, 1, frame(8), { configurationHash: hash(change.candidate) }));
  assert.throws(() => store.confirm(change.id, 'test-user'));
  receive(store, now, 2, frame(8, 0x1f, 0x40, 1), { configurationHash: hash(change.candidate) });
  assert.equal(deviceHealth(store, device.value.stationId), true);
  assert.equal(store.confirm(change.id, 'test-user').state, 'confirming');
});

test('public projection expires ISS measurements without another packet and preserves incomplete rain', (t) => {
  const { store, now, tick } = setup(t),
    station = store.stationList()[0].value;
  receive(store, now, 1, frame(8, 0x1f, 0x40));
  tick(1000);
  receive(store, now, 2, frame(14, 30));
  const projection = publicProjection(store);
  try {
    projection.sync();
    assert.notEqual(legacy(projection.store, station).temp, '');
    tick(61000);
    assert.equal(legacy(projection.store, station).temp, '');
    assert.equal(legacy(projection.store, station).wlatest, '');
    assert.equal(legacy(projection.store, station).dew, '');
    assert.equal(dayResponse(projection.store, station.key, '2026-10-19').dailyRainfall, null);
  } finally {
    projection.close();
  }
});
