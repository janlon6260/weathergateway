import test from 'node:test';
import assert from 'node:assert/strict';
import { crcCcitt, decodeLoop } from '../server/davis.js';
import { setup, observation } from './helpers.js';
import { ingest, snapshot } from '../server/observations.js';

function frame(type = 1) {
  const p = Buffer.alloc(99, 255);
  p.write('LOO');
  p[4] = type;
  p.writeUInt16LE(29920, 7);
  p.writeInt16LE(680, 9);
  p[11] = 40;
  p.writeInt16LE(140, 12);
  p[14] = 10;
  p[15] = 8;
  p.writeUInt16LE(360, 16);
  p.writeUInt16LE(80, 18);
  p.writeUInt16LE(120, 22);
  p[33] = 70;
  p.writeUInt16LE(5, 41);
  p.writeUInt16LE(400, 44);
  p.writeUInt16LE(12, 50);
  p[95] = 10;
  p[96] = 13;
  p.writeUInt16BE(crcCcitt(p.subarray(0, 97)), 97);
  return p;
}
test('CRC-CCITT known XMODEM check value', () => assert.equal(crcCcitt(Buffer.from('123456789')), 0x31c3));
test('Davis LOOP2 uses correct signed temperature, wind scale, direction and gauge', () => {
  const result = decodeLoop(frame(), 0.2);
  assert.equal(result.measurements.temperatureC, -10);
  assert.equal(result.measurements.indoorTemperatureC, 20);
  assert.equal(result.measurements.windSpeedMs, 4.4704);
  assert.ok(Math.abs(result.measurements.windMeanMs - 3.57632) < 1e-8);
  assert.ok(Math.abs(result.measurements.windGustMs - 5.36448) < 1e-8);
  assert.equal(result.measurements.windDirectionDeg, 0);
  assert.ok(Math.abs(result.measurements.rainTodayMm - 2.4) < 1e-8);
  assert.equal(result.sensorContact, true);
});
test('Davis packet corruption is rejected and missing sentinels do not become values', () => {
  const p = frame();
  p[12] ^= 1;
  assert.throws(() => decodeLoop(p, 0.2));
  p.writeUInt16LE(0x7fff, 12);
  p[33] = 255;
  p.writeUInt16BE(crcCcitt(p.subarray(0, 97)), 97);
  const decoded = decodeLoop(p, 0.2);
  assert.equal(decoded.measurements.temperatureC, null);
  assert.equal(decoded.sensorContact, false);
});
test('raw Davis packet is decoded on the gateway and retained for reproducibility', (t) => {
  const { store, now } = setup(t),
    station = store.stationList()[0].value;
  ingest(
    store,
    station.id,
    observation(station.id, now(), {
      measurements: {},
      source: { protocol: 'davis-loop', packet: frame().toString('base64') },
    }),
  );
  assert.equal(snapshot(store)[station.key].temp, '-10.0');
  assert.equal(snapshot(store)[station.key].rfall, '2.4');
});
test('ny regnkalibrering gjelder nye vipp, ikke allerede registrert døgnsum', (t) => {
  const { store, now, tick } = setup(t),
    s = store.stationList()[0],
    send = (seq, packet) =>
      ingest(
        store,
        s.value.id,
        observation(s.value.id, now(), {
          sequence: seq,
          source: { protocol: 'davis-loop', packet: packet.toString('base64') },
        }),
      );
  send(1, frame());
  const c = store.propose(s.scope, { ...s.value, rainCounterMmPerUnit: 0.3 }, s.revision, 'test');
  store.begin(c.id, 'test');
  store.health(c.id, true, {});
  store.confirm(c.id, 'test');
  tick(2000);
  const next = frame();
  next.writeUInt16LE(13, 50);
  next.writeUInt16BE(crcCcitt(next.subarray(0, 97)), 97);
  send(2, next);
  assert.equal(snapshot(store)[s.value.key].rfall, '2.7');
});
test('CRC-gyldige, fysisk ugyldige vind- og regnverdier blir manglende data', () => {
  const p = frame();
  p.writeUInt16LE(32760, 18);
  p.writeUInt16LE(32760, 22);
  p.writeUInt16LE(65534, 50);
  p.writeUInt16BE(crcCcitt(p.subarray(0, 97)), 97);
  const decoded = decodeLoop(p, 0.2);
  assert.equal(decoded.measurements.windMeanMs, null);
  assert.equal(decoded.measurements.windGustMs, null);
  assert.equal(decoded.measurements.rainTodayMm, null);
  assert.equal(decoded.rawFields.rainTodayClicks, null);
});
