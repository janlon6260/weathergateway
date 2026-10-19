import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, directory } from './helpers.js';
import { controlApp, publicApp } from '../server/app.js';
import { Rejected } from '../server/store.js';

async function login(app) {
  const agent = request.agent(app);
  const result = await agent
    .post('/api/login')
    .set('Origin', 'http://localhost:5173')
    .send({ username: 'test', password: 'valid-test-password' })
    .expect(200);
  return { agent, csrf: result.body.csrf };
}
test('admin krever innlogging og sikker cookie uten passord i sesjonen', async (t) => {
  const { store, config } = setup(t),
    { app } = controlApp({ store, config, directory: directory() });
  await request(app).get('/api/state').expect(401);
  const { agent } = await login(app);
  const s = await agent.get('/api/session').expect(200);
  assert.equal(s.body.principal.username, 'test');
  assert.equal(
    JSON.stringify(store.db.prepare('SELECT * FROM sessions').all()).includes('valid-test-password'),
    false,
  );
});
test('cross-origin login og mutasjoner uten CSRF avvises', async (t) => {
  const { store, config } = setup(t),
    { app } = controlApp({ store, config, directory: directory() });
  await request(app)
    .post('/api/login')
    .set('Origin', 'https://evil.example')
    .send({ username: 'test', password: 'valid-test-password' })
    .expect(403);
  const { agent } = await login(app);
  await agent.post('/api/logout').set('Origin', 'http://localhost:5173').send({}).expect(403);
});
test('leser kan ikke endre innstillinger eller utstede sertifikater', async (t) => {
  const { store, config } = setup(t),
    { app } = controlApp({ store, config, directory: directory(['viewer']) }),
    { agent, csrf } = await login(app);
  await agent
    .post('/api/changes')
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', csrf)
    .send({})
    .expect(403);
  await agent.get('/api/audit').expect(403);
});
test('operatør har ikke gateway-/produksjonspromoteringsrettigheter', async (t) => {
  const { store, config } = setup(t),
    { app } = controlApp({ store, config, directory: directory(['operator']) }),
    { agent, csrf } = await login(app),
    current = store.current('gateway');
  await agent
    .post('/api/changes')
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', csrf)
    .send({ scope: 'gateway', revision: current.revision, value: current.value })
    .expect(403);
});
test('utkast, test, bekreftelse og revisjon fungerer via Express', async (t) => {
  const { store, config } = setup(t),
    { app } = controlApp({ store, config, directory: directory() }),
    { agent, csrf } = await login(app),
    current = store.current('gateway');
  const post = (url, body) =>
    agent.post(url).set('Origin', 'http://localhost:5173').set('X-CSRF-Token', csrf).send(body);
  const draft = await post('/api/changes', {
    scope: 'gateway',
    revision: current.revision,
    value: { ...current.value, confirmationSeconds: 90 },
  }).expect(201);
  await post(`/api/changes/${draft.body.id}/test`, {}).expect(200);
  const result = await post(`/api/changes/${draft.body.id}/confirm`, {}).expect(200);
  assert.equal(result.body.state, 'confirmed');
});
test('ugyldig AD-kandidat blir ikke aktivert', async (t) => {
  const { store, config } = setup(t),
    { app } = controlApp({ store, config, directory: directory() }),
    { agent, csrf } = await login(app),
    current = store.current('gateway');
  const post = (url, body) =>
    agent.post(url).set('Origin', 'http://localhost:5173').set('X-CSRF-Token', csrf).send(body);
  const draft = await post('/api/changes', {
    scope: 'gateway',
    revision: current.revision,
    value: { ...current.value, directory: { ...current.value.directory, baseDn: 'bad' } },
  }).expect(201);
  await post(`/api/changes/${draft.body.id}/test`, {}).expect(409);
  assert.equal(store.current('gateway').value.directory.baseDn, current.value.directory.baseDn);
});
test('offentlig Express-app har ingen administrative ruter', async (t) => {
  const { store, config } = setup(t);
  config.publicToken = 'x'.repeat(40);
  const { app } = publicApp({ store, config: { ...config, role: 'public' } });
  await request(app).get('/weather/current').expect(401);
  await request(app).get('/weather/current').set('Authorization', `Bearer ${config.publicToken}`).expect(200);
  await request(app)
    .post('/api/login')
    .set('Authorization', `Bearer ${config.publicToken}`)
    .send({ username: 'test', password: 'valid-test-password' })
    .expect(404);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});
test('sesjon tilbakekalles når AD-tilgang fjernes', async (t) => {
  const { store, config } = setup(t),
    provider = directory(),
    { app } = controlApp({ store, config, directory: provider }),
    { agent, csrf } = await login(app);
  provider.refresh = async () => {
    throw new Rejected('Tilgang tilbakekalt', 401);
  };
  await agent
    .post('/api/logout')
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', csrf)
    .send({})
    .expect(401);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});
test('bakgrunnspolling forlenger ikke en inaktiv sesjon', async (t) => {
  const { store, config, tick } = setup(t),
    { app } = controlApp({ store, config, directory: directory() }),
    { agent } = await login(app);
  tick(20 * 60000);
  await agent.get('/api/state').expect(200);
  tick(11 * 60000);
  await agent.get('/api/state').expect(401);
});
test('endret adminadresse må bekreftes gjennom den nye adressen', async (t) => {
  const { store, config } = setup(t),
    { app } = controlApp({ store, config, directory: directory() }),
    { agent, csrf } = await login(app),
    current = store.current('gateway');
  const post = (url, body, origin = 'http://localhost:5173', host = 'localhost:5173') =>
    agent.post(url).set('Origin', origin).set('Host', host).set('X-CSRF-Token', csrf).send(body);
  const draft = await post('/api/changes', {
    scope: 'gateway',
    revision: current.revision,
    value: { ...current.value, adminOrigin: 'https://new-admin.example.test' },
  }).expect(201);
  await post(`/api/changes/${draft.body.id}/test`, {}).expect(200);
  await post(`/api/changes/${draft.body.id}/confirm`, {}).expect(409);
  await post(
    `/api/changes/${draft.body.id}/confirm`,
    {},
    'https://new-admin.example.test',
    'new-admin.example.test',
  ).expect(200);
});
