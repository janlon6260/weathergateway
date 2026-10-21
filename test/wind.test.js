import test from 'node:test';
import assert from 'node:assert/strict';
import { beaufort, windPresentation } from '../shared/wind.js';
test('wind arrows point towards the destination, use clockwise degrees from north and place Beaufort on the speed scale', () => {
  assert.deepEqual(
    [0, 90, 180, 270, 360].map((from) => windPresentation(6, from).toDegrees),
    [180, 270, 0, 90, 180],
  );
  const west = windPresentation(6, 270);
  assert.equal(west.toCompass, 'Ø');
  assert.equal(west.arrowRotationDegrees, 90);
  assert.equal(west.beaufort, 4);
  assert.equal(windPresentation(0, 270).toDegrees, null);
  assert.equal(windPresentation(0, null).beaufort, 0);
  for (const speed of [null, undefined, NaN, -1, Infinity, '6']) assert.equal(beaufort(speed), null);
  for (const bearing of [null, undefined, NaN, -1, 361, '270'])
    assert.equal(windPresentation(6, bearing).toDegrees, null);
  for (const [speed, force] of [
    [0, 0],
    [0.29, 0],
    [0.3, 1],
    [1.6, 2],
    [3.4, 3],
    [5.5, 4],
    [8, 5],
    [10.8, 6],
    [13.9, 7],
    [17.2, 8],
    [20.8, 9],
    [24.5, 10],
    [28.5, 11],
    [32.7, 12],
  ])
    assert.equal(beaufort(speed), force);
});
