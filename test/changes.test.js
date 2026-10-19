import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, observation } from './helpers.js';
import { Store, hash } from '../server/store.js';
import { handleAck, handleMessage } from '../server/worker.js';

function propose(store, timeout = 300) {
  const current = store.current('gateway');
  return store.propose(
    'gateway',
    { ...current.value, confirmationSeconds: timeout },
    current.revision,
    'test-user',
  );
}
test('utkast påvirker ikke aktiv konfigurasjon; bare én åpen endring', (t) => {
  const { store } = setup(t),
    before = store.current('gateway');
  const c = propose(store, 60);
  assert.deepEqual(store.current('gateway'), before);
  assert.equal(c.state, 'draft');
  assert.throws(() => propose(store));
});
test('testfrist bruker tidligere bekreftet verdi; leser ikke kandidatens frist', (t) => {
  const { store, now } = setup(t),
    c = propose(store, 60);
  store.begin(c.id, 'test-user');
  assert.equal(store.getChange(c.id).deadline, now() + 300000);
});
test('frist utløper selv om brukeren lukker nettleseren, og sen bekreftelse gjenoppretter', (t) => {
  const { store, tick } = setup(t),
    c = propose(store, 60);
  store.begin(c.id, 'test-user');
  store.health(c.id, true, {});
  tick(300000);
  assert.throws(() => store.confirm(c.id, 'test-user'));
  assert.equal(store.getChange(c.id).state, 'rolled_back');
  assert.equal(store.current('gateway').value.confirmationSeconds, 300);
});
test('omstart gjenoppretter utløpt prøve fra varig lagring', (t) => {
  const { store, tick, now } = setup(t),
    c = propose(store, 60);
  store.begin(c.id, 'test-user');
  tick(300001);
  const restarted = new Store({ root: store.root, environment: 'test', clock: now });
  try {
    assert.equal(restarted.getChange(c.id).state, 'rolled_back');
  } finally {
    restarted.close();
  }
});
test('bekreftelse trenger fersk uavhengig helsesjekk', (t) => {
  const { store, tick } = setup(t),
    c = propose(store, 60);
  store.begin(c.id, 'user');
  assert.throws(() => store.confirm(c.id, 'user'));
  store.health(c.id, true, {});
  tick(30001);
  assert.throws(() => store.confirm(c.id, 'user'));
  store.health(c.id, true, {});
  assert.equal(store.confirm(c.id, 'user').state, 'confirmed');
  tick(400000);
  store.sweep();
  assert.equal(store.current('gateway').value.confirmationSeconds, 60);
});
test('mislykket helsesjekk og klokke tilbake ruller tilbake', (t) => {
  const { store, tick } = setup(t);
  let c = propose(store, 60);
  store.begin(c.id, 'user');
  store.health(c.id, false, {});
  assert.equal(store.getChange(c.id).reason, 'health_failed');
  c = propose(store, 70);
  store.begin(c.id, 'user');
  tick(-10000);
  store.sweep();
  assert.equal(store.getChange(c.id).reason, 'clock_regressed');
  const draft = propose(store, 80);
  assert.throws(() => store.begin(draft.id, 'user'));
});
test('revisjoner hindrer tap av samtidige endringer', (t) => {
  const { store } = setup(t),
    c = propose(store, 60);
  store.begin(c.id, 'user');
  store.rollback(c.id);
  assert.throws(() => store.propose('gateway', c.candidate, c.base_revision, 'user'));
});
test('miljømarkør og database nekter gjenbruk på tvers av miljøer', (t) => {
  const { store } = setup(t);
  assert.throws(() => new Store({ root: store.root, environment: 'production' }));
});
test('enhetsendring venter på faktisk enhetskvittering etter Gjør gjeldende', (t) => {
  const { store, now } = setup(t),
    device = store.configurations('device:')[0];
  const c = store.propose(device.scope, { ...device.value, sampleSeconds: 5 }, device.revision, 'user');
  store.begin(c.id, 'user');
  assert.throws(() => store.confirm(c.id, 'user'));
  const trial = store.db.prepare("SELECT * FROM commands WHERE kind='test_config'").get();
  handleAck(store, device.value.stationId, {
    version: 1,
    stationId: device.value.stationId,
    commandId: trial.id,
    status: 'testing',
    configurationHash: hash(c.candidate),
  });
  assert.throws(() => store.confirm(c.id, 'user'));
  handleMessage(
    store,
    `wg/v1/test/stations/${device.value.stationId}/telemetry`,
    Buffer.from(
      JSON.stringify(observation(device.value.stationId, now(), { configurationHash: hash(c.candidate) })),
    ),
  );
  assert.equal(store.confirm(c.id, 'user').state, 'confirming');
  const commit = store.db.prepare("SELECT * FROM commands WHERE kind='commit_config'").get();
  assert.equal(commit.deadline, now() + 300000);
  handleAck(store, device.value.stationId, {
    version: 1,
    stationId: device.value.stationId,
    commandId: commit.id,
    status: 'applied',
    configurationHash: hash(c.candidate),
  });
  assert.equal(store.getChange(c.id).state, 'confirmed');
});
test('ACK for annen konfigurasjon eller enhet kan ikke godkjenne en test', (t) => {
  const { store } = setup(t),
    device = store.configurations('device:')[0];
  const c = store.propose(device.scope, { ...device.value, sampleSeconds: 5 }, device.revision, 'user');
  store.begin(c.id, 'user');
  const command = store.db.prepare('SELECT * FROM commands').get();
  assert.throws(() =>
    handleAck(store, device.value.stationId, {
      version: 1,
      stationId: device.value.stationId,
      commandId: command.id,
      status: 'testing',
      configurationHash: 'a'.repeat(64),
    }),
  );
  assert.equal(store.getChange(c.id).health, null);
});
