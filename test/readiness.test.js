import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, directory } from './helpers.js';
import { controlApp } from '../server/app.js';
import { readiness, deploymentFingerprint } from '../server/readiness.js';

test('readiness never substitutes manual assertions for missing worker, device security or SQL delivery', (t) => {
  const { store, config } = setup(t);
  const fingerprint = deploymentFingerprint(store);
  for (const check of [
    'dockerRuntime',
    'externalIsolation',
    'radioReference',
    'deviceRollback',
    'restore',
    'compatibility',
  ])
    store.db
      .prepare('INSERT INTO deployment_acceptance VALUES (?,?,?,?,?,?)')
      .run(
        check,
        fingerprint,
        store.clock(),
        'tester',
        1,
        'Isolated acceptance fixture with recorded evidence.',
      );
  const report = readiness(store, config);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find((c) => c.id === 'worker').passed, false);
  assert.equal(
    report.checks.filter((c) => c.id.startsWith('deviceSecurity:')).every((c) => !c.passed),
    true,
  );
  assert.equal(report.checks.find((c) => c.id === 'externalIsolation').passed, true);
  const current = store.current('gateway'),
    change = store.propose(
      'gateway',
      { ...current.value, confirmationSeconds: 90 },
      current.revision,
      'tester',
    );
  store.begin(change.id, 'tester');
  store.health(change.id, true, {});
  store.confirm(change.id, 'tester');
  assert.notEqual(deploymentFingerprint(store), fingerprint);
  assert.equal(readiness(store, config).checks.find((c) => c.id === 'externalIsolation').passed, false);
});
test('readiness evidence is administrator-only, CSRF protected and bound to the current configuration', async (t) => {
  const { store, config } = setup(t),
    { app } = controlApp({ store, config, directory: directory() });
  const agent = request.agent(app),
    origin = config.defaults.adminOrigin;
  await agent.get('/api/readiness').expect(401);
  const { body: session } = await agent
    .post('/api/login')
    .set('Origin', origin)
    .send({ username: 'test', password: 'valid-test-password' })
    .expect(200);
  const { body: report } = await agent.get('/api/readiness').expect(200);
  const evidence = {
    checkId: 'externalIsolation',
    configurationHash: report.configurationHash,
    passed: true,
    note: 'Test fixture only: a separate external network was checked.',
  };
  await agent.post('/api/readiness/evidence').set('Origin', origin).send(evidence).expect(403);
  await agent
    .post('/api/readiness/evidence')
    .set('Origin', origin)
    .set('X-CSRF-Token', session.csrf)
    .send({ ...evidence, configurationHash: '0'.repeat(64) })
    .expect(409);
  const { body: updated } = await agent
    .post('/api/readiness/evidence')
    .set('Origin', origin)
    .set('X-CSRF-Token', session.csrf)
    .send(evidence)
    .expect(200);
  assert.equal(updated.checks.find((c) => c.id === 'externalIsolation').passed, true);
  assert.equal(updated.ready, false);
  const { app: viewer } = controlApp({ store, config, directory: directory(['viewer']) }),
    reader = request.agent(viewer);
  const { body: readerSession } = await reader
    .post('/api/login')
    .set('Origin', origin)
    .send({ username: 'test', password: 'valid-test-password' })
    .expect(200);
  await reader.get('/api/readiness').expect(403);
  await reader
    .post('/api/readiness/evidence')
    .set('Origin', origin)
    .set('X-CSRF-Token', readerSession.csrf)
    .send(evidence)
    .expect(403);
  await reader
    .post('/api/firmware')
    .set('Origin', origin)
    .set('X-CSRF-Token', readerSession.csrf)
    .send({})
    .expect(403);
  await reader
    .post('/api/history-import')
    .set('Origin', origin)
    .set('X-CSRF-Token', readerSession.csrf)
    .send({})
    .expect(403);
});
