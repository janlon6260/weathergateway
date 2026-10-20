import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, observation } from './helpers.js';
import { durableTelemetryReceipt } from '../server/worker.js';

test('application receipts follow durable ingestion and are idempotent; storage failure never releases the device spool', (t) => {
  const { store, now } = setup(t),
    stationId = store.stationList()[0].value.id;
  const body = observation(stationId, now()),
    payload = Buffer.from(JSON.stringify(body));
  assert.equal(durableTelemetryReceipt(store, stationId, payload).status, 'stored');
  assert.equal(durableTelemetryReceipt(store, stationId, payload).status, 'stored');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
  store.db.exec(
    "CREATE TRIGGER no_writes BEFORE INSERT ON observations BEGIN SELECT RAISE(FAIL,'disk unavailable'); END;",
  );
  assert.throws(() =>
    durableTelemetryReceipt(store, stationId, Buffer.from(JSON.stringify({ ...body, sequence: 2 }))),
  );
});
test('untimed or invalid observations are durably retained for diagnosis without invented UTC or weather values', (t) => {
  const { store, now } = setup(t),
    stationId = store.stationList()[0].value.id;
  const body = observation(stationId, now());
  delete body.observedAt;
  body.monotonicUs = 12345;
  const receipt = durableTelemetryReceipt(store, stationId, Buffer.from(JSON.stringify(body)), {
    undated: true,
  });
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.reason, 'CLOCK_UNAVAILABLE');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM telemetry_rejections').get().n, 1);
});
