import test from 'node:test';
import assert from 'node:assert/strict';
import {
  referenceEt,
  extraterrestrialRadiation,
  clearSkyRadiation,
  degreeDays,
  growingDegreeDays,
} from '../server/climate.js';
import { rollingWind, climateDay } from '../server/weather-analytics.js';
import { ingest } from '../server/observations.js';
import { setup, observation } from './helpers.js';
import { publicProjection } from '../server/public-projection.js';

test('FAO-56 published Uccle example 18: daily reference ET is 3.88 mm, missing pressure stays missing', () => {
  const input = {
    minC: 12.3,
    maxC: 21.5,
    actualVapourKpa: 1.409,
    windMs: 10 / 3.6,
    windHeightM: 10,
    solarMj: 22.07,
    stationPressureHpa: 1001,
    latitude: 50.8,
    elevationM: 100,
    dayOfYear: 187,
  };
  assert.ok(Math.abs(extraterrestrialRadiation(50.8, 187) - 41.09) < 0.05);
  assert.ok(Math.abs(referenceEt(input) - 3.88) < 0.03);
  assert.equal(referenceEt({ ...input, stationPressureHpa: null }), null);
  assert.equal(referenceEt({ ...input, windMs: null }), null);
  assert.equal(extraterrestrialRadiation(89, 355), 0);
});

test('degree days use min/max means, agricultural caps and explicit Celsius bases', () => {
  assert.deepEqual(degreeDays(5, 15, 18), { heating: 8, cooling: 0, baseC: 18 });
  assert.equal(degreeDays(20, 30, 18).cooling, 7);
  assert.equal(growingDegreeDays(5, 35, 10, 30), 10);
  assert.equal(degreeDays(null, 20), null);
  assert.equal(clearSkyRadiation(-5), 0);
  assert.ok(Math.abs(clearSkyRadiation(90) - 1035.084) < 0.02);
});

test('wind integrates elapsed time, handles north/calm/gaps and repairs late intervals without double counting', (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  const start = state.now();
  const send = (offset, speed, direction, sequence) => {
    if (state.now() < start + offset) state.tick(start + offset - state.now());
    return ingest(
      state.store,
      station.id,
      observation(station.id, start + offset, {
        sequence,
        measurements: { windSpeedMs: speed, windDirectionDeg: direction },
      }),
    );
  };
  send(0, 2, 359, 1);
  send(10000, 6, 1, 2);
  assert.equal(rollingWind(state.store, station, start + 10000).meanMs, null);
  send(5000, 4, 0, 3);
  let day = climateDay(state.store, station, '2026-10-19');
  assert.equal(day.windRunObservedKm, 0.03);
  assert.equal(
    day.windRose.reduce((sum, bin) => sum + bin.percent, 0),
    100,
  );
  send(5000, 100, 180, 4); // same timestamp cannot replace the first recorded sample
  assert.equal(climateDay(state.store, station, '2026-10-19').windRunObservedKm, 0.03);
  state.tick(100000);
  send(100000, 3, 180, 5); // no integration across a 90 second outage
  day = climateDay(state.store, station, '2026-10-19');
  assert.equal(day.windRunObservedKm, 0.03);
  assert.ok(Math.abs(rollingWind(state.store, station, start + 10000).gustMs - 4) < 1e-9);
});

test('configured wind window is time weighted and the public projection preserves its sufficient statistics', (t) => {
  const state = setup(t),
    record = state.store.stationList()[0],
    station = { ...record.value, meteorology: { ...record.value.meteorology, windWindowSeconds: 60 } };
  state.store.db
    .prepare('UPDATE configuration SET payload=? WHERE scope=?')
    .run(JSON.stringify(station), record.scope);
  const start = state.now();
  for (let i = 0; i <= 6; i++) {
    state.tick(i ? 10000 : 0);
    ingest(
      state.store,
      station.id,
      observation(station.id, state.now(), {
        sequence: i,
        measurements: { windSpeedMs: i < 3 ? 2 : 4, windDirectionDeg: i < 3 ? 359 : 1 },
      }),
    );
  }
  const wind = rollingWind(state.store, station, start + 60000);
  assert.equal(wind.coverage, 1);
  assert.equal(wind.meanMs, 3);
  assert.ok(wind.directionDeg < 1 || wind.directionDeg > 359);
  assert.equal(wind.gustMs, 4);
  const projection = publicProjection(state.store);
  try {
    projection.sync();
    assert.deepEqual(rollingWind(projection.store, station, start + 60000), wind);
  } finally {
    projection.close();
  }
});

test('climate day length follows Oslo DST and incomplete daily data cannot manufacture degree days or ET', (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  assert.equal(climateDay(state.store, station, '2026-03-29').expectedSeconds, 23 * 3600);
  assert.equal(climateDay(state.store, station, '2026-10-25').expectedSeconds, 25 * 3600);
  const day = climateDay(state.store, station, '2026-10-18');
  assert.equal(day.heatingDegreeDays, null);
  assert.equal(day.referenceEtMm, null);
  assert.ok(day.referenceEtMissingInputs.includes('stationPressureHpa'));
});
