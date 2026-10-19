import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dewPoint,
  windChill,
  heatIndex,
  humidex,
  apparentTemperature,
  beaufort,
  vectorDirection,
} from '../server/meteo.js';

const near = (actual, expected, tolerance = 0.1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
test('duggpunkt: metning, kjent eksempel og manglende fukt', () => {
  near(dewPoint(20, 100), 20, 1e-8);
  near(dewPoint(20, 50), 9.26);
  assert.equal(dewPoint(20, 0), null);
  assert.equal(dewPoint(null, 50), null);
});
test('NWS vindavkjøling med enheter og gyldighetsområde', () => {
  near(windChill(-10, 5), -17.45);
  assert.equal(windChill(20, 5), null);
  assert.equal(windChill(-10, 0), null);
});
test('NWS varmeindeks: 90 F og 70 prosent RH', () => {
  near(heatIndex((90 - 32) / 1.8, 70), (105.92 - 32) / 1.8, 0.1);
  assert.equal(heatIndex(10, 50), null);
});
test('humidex og tilsynelatende temperatur beregnes bare med gyldige innganger', () => {
  near(humidex(30, 20), 37.57, 0.15);
  near(apparentTemperature(20, 50, 5), 16.35, 0.15);
  assert.equal(humidex(10, 0), null);
  assert.equal(apparentTemperature(20, null, 0), null);
});
test('sirkulær vindretning og Beaufort bevarer vindstille', () => {
  near(
    vectorDirection([
      { speed: 1, direction: 359 },
      { speed: 1, direction: 1 },
    ]),
    0,
    1e-8,
  );
  assert.equal(vectorDirection([{ speed: 0, direction: 90 }]), null);
  assert.equal(beaufort(0), 0);
  assert.equal(beaufort(null), null);
  assert.equal(beaufort(33), 12);
});
