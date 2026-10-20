import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, observation } from './helpers.js';
import { ingest } from '../server/observations.js';
import { evaluateAlarm, checkAlarms, alarmStatus } from '../server/alarms.js';

const rule = {
  id: '402500fa-a03b-4dcf-af73-11109f9b8329',
  name: 'Frost',
  enabled: true,
  metric: 'temperatureC',
  comparison: 'below',
  threshold: 0,
  hysteresis: 2,
  delaySeconds: 60,
  clearDelaySeconds: 30,
};
test('alarm delay, hysteresis and delayed recovery tolerate missing data without false clearing', () => {
  let state = evaluateAlarm(null, rule, -1, 100000);
  assert.equal(state.active, 0);
  state = evaluateAlarm(state, rule, -2, 160000);
  assert.equal(state.event, 'activated');
  state = evaluateAlarm(state, rule, 1, 200000);
  assert.equal(state.active, 1);
  state = evaluateAlarm(state, rule, null, 210000);
  assert.equal(state.active, 1);
  assert.equal(state.suspended, 1);
  state = evaluateAlarm(state, rule, 3, 220000);
  assert.equal(state.active, 1);
  state = evaluateAlarm(state, rule, 3, 250000);
  assert.equal(state.event, 'cleared');
});
test('alarm configuration trials cannot trigger production alarms; confirmed rules and events survive repeated checks', (t) => {
  const s = setup(t),
    stationId = s.store.stationList()[0].value.id,
    scope = `alarms:${stationId}`;
  const config = s.store.current(scope),
    draft = s.store.propose(
      scope,
      { stationId, rules: [{ ...rule, delaySeconds: 0 }] },
      config.revision,
      'admin',
    );
  s.store.begin(draft.id, 'admin');
  ingest(s.store, stationId, observation(stationId, s.now(), { measurements: { temperatureC: -1 } }));
  checkAlarms(s.store);
  assert.equal(alarmStatus(s.store).events.length, 0);
  s.store.health(draft.id, true, { schema: 'ok' });
  s.store.confirm(draft.id, 'admin');
  checkAlarms(s.store);
  checkAlarms(s.store);
  assert.equal(alarmStatus(s.store).events.length, 1);
  assert.equal(alarmStatus(s.store).states[0].active, 1);
});
test('ISS alarm rules expire each sensor field even before the general station warning threshold', (t) => {
  const s = setup(t),
    stationId = s.store.stationList()[0].value.id,
    scope = `alarms:${stationId}`,
    current = s.store.current(scope);
  const draft = s.store.propose(
    scope,
    { stationId, rules: [{ ...rule, comparison: 'missing', delaySeconds: 0 }] },
    current.revision,
    'admin',
  );
  s.store.begin(draft.id, 'admin');
  s.store.health(draft.id, true, {});
  s.store.confirm(draft.id, 'admin');
  ingest(
    s.store,
    stationId,
    observation(stationId, s.now(), {
      source: {
        protocol: 'davis-iss',
        packet: Buffer.from('8004700f99009111ffff', 'hex').toString('base64'),
        channel: 0,
        rssiDbm: -77,
      },
    }),
  );
  checkAlarms(s.store);
  assert.equal(alarmStatus(s.store).states[0].active, 0);
  s.tick(61000);
  checkAlarms(s.store);
  assert.equal(alarmStatus(s.store).states[0].active, 1);
});
