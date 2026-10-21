import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWindDirection, windDirectionDefaults } from '../shared/wind-direction.js';
import { windPresentation } from '../shared/wind.js';
import { stationSchema } from '../server/schema.js';
import { decodeIss, decodeWiredIss } from '../server/davis-iss.js';
import { crcCcitt } from '../server/davis.js';
import { setup, observation } from './helpers.js';
import { ingest, latest } from '../server/observations.js';
import { recentPackets } from '../server/raw-packets.js';
const model = 'Davis Vantage Pro2';
function frame(direction) {
  const bytes = Buffer.from([0x80, 4, direction, 0x0f, 0x99, 0, 0, 0, 255, 255]);
  bytes.writeUInt16BE(crcCcitt(bytes.subarray(0, 6)), 6);
  return bytes;
}
test('wind profiles preserve existing defaults, handle north ambiguity and map cardinal directions without changing speed or temperature', () => {
  for (const [raw, expected] of [
    [0, 0],
    [1, 10.341176470588236],
    [128, 180.67058823529413],
    [255, 351],
  ])
    assert.ok(Math.abs(decodeWindDirection(raw, model) - expected) < 1e-9);
  assert.ok(Math.abs(decodeWindDirection(128, 'Davis Vantage Vue') - 180.3) < 1e-9);
  assert.equal(decodeWindDirection(0, model, { zero: 'missing' }), null);
  assert.equal(decodeWindDirection(0, model, { zero: 'decode' }), 9);
  assert.equal(decodeWindDirection(0, model, { decoder: 'davis-pro2-adjusted', zero: 'decode' }), 5);
  assert.equal(decodeWindDirection(255, model, { decoder: 'davis-pro2-adjusted' }), 355);
  assert.equal(decodeWindDirection(1, model, { decoder: 'davis-pro2-adjusted' }), 9);
  assert.equal(decodeWindDirection(254, model, { decoder: 'davis-pro2-adjusted' }), 351);
  for (const [raw, from, to] of [
    [0, 0, 180],
    [64, 90, 270],
    [128, 180, 0],
    [192, 270, 90],
  ]) {
    const settings = { ...windDirectionDefaults, decoder: 'linear-256' };
    const decoded = decodeIss(frame(raw), model, 0.2, settings);
    assert.equal(decoded.measurements.windDirectionDeg, from);
    assert.equal(
      decodeWiredIss(frame(raw).subarray(0, 6), model, 0.2, settings).measurements.windDirectionDeg,
      from,
    );
    assert.equal(windPresentation(decoded.measurements.windSpeedMs, from).toDegrees, to);
    assert.equal(decoded.measurements.windSpeedMs, 1.78816);
    assert.ok(Math.abs(decoded.measurements.temperatureC - -3.9131944444444446) < 1e-9);
  }
  assert.equal(decodeWindDirection(64, model, { decoder: 'linear-256', reverse: true }), 270);
  assert.equal(
    decodeWindDirection(64, model, {
      decoder: 'custom',
      rawStart: 0,
      rawEnd: 128,
      degreesStart: 0,
      degreesEnd: 180,
    }),
    90,
  );
  assert.equal(decodeWindDirection(1, model, { decoder: 'custom', rawStart: 1, rawEnd: 1 }), null);
  for (const invalid of [-1, 256, 1.5, NaN]) assert.equal(decodeWindDirection(invalid, model), null);
});
test('invalid wind profiles and degenerate scaling cannot enter station settings', (t) => {
  const { store } = setup(t),
    station = store.stationList()[0].value;
  for (const changes of [
    { decoder: 'unknown' },
    { rawEnd: 256 },
    { decoder: 'custom', rawEnd: 0 },
    { decoder: 'custom', degreesEnd: 0 },
  ])
    assert.equal(
      stationSchema.safeParse({ ...station, windDirection: { ...windDirectionDefaults, ...changes } })
        .success,
      false,
    );
});
test('confirmed wind correction affects new ISS packets, preserves raw bytes and never rewrites earlier observations', (t) => {
  const { store, now, tick } = setup(t),
    record = store.stationList()[0],
    station = record.value;
  const receive = (sequence) =>
    ingest(
      store,
      station.id,
      observation(station.id, now(), {
        sequence,
        source: { protocol: 'davis-iss', packet: frame(64).toString('base64'), channel: 1, rssiDbm: -63 },
      }),
    );
  receive(1);
  const original = latest(store, station.id);
  const change = store.propose(
    record.scope,
    {
      ...station,
      windDirection: { ...windDirectionDefaults, decoder: 'linear-256', reverse: true },
      calibration: { ...station.calibration, windDirectionOffsetDeg: 90 },
    },
    record.revision,
    'test',
  );
  store.begin(change.id, 'test');
  tick(1);
  receive(2);
  assert.equal(
    latest(store, station.id).measurements.windDirectionDeg,
    original.measurements.windDirectionDeg,
  );
  store.health(change.id, true, { schema: 'ok' });
  store.confirm(change.id, 'test');
  tick(1);
  receive(3);
  const current = latest(store, station.id);
  assert.equal(current.measurements.windDirectionDeg, 0);
  assert.equal(current.rawMeasurements.windDirectionDeg, 270);
  assert.equal(current.iss.rawWindDirectionByte, 64);
  const packets = recentPackets(store, station.id).packets;
  assert.equal(
    packets.find((p) => p.sequence === 1).measurements.windDirectionDeg,
    original.measurements.windDirectionDeg,
  );
  assert.equal(packets.find((p) => p.sequence === 3).rawWindDirectionByte, 64);
  assert.ok(packets[0].calibrationRevision > packets.at(-1).calibrationRevision);
});
