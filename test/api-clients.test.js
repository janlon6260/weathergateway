import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { setup, directory, observation } from './helpers.js';
import { ApiClients, PublicAccess } from '../server/api-clients.js';
import { controlApp, publicApp } from '../server/app.js';
import { ingest } from '../server/observations.js';
import { publicProjection } from '../server/public-projection.js';
function environment(t) {
  const s = setup(t);
  s.config.publicAccessFile = s.store.safe('policies', 'socket-clients.json');
  const clients = new ApiClients(s.store, s.config);
  clients.publish();
  return { ...s, clients };
}
const valueOf = (client) =>
  Object.fromEntries(
    [
      'name',
      'description',
      'enabled',
      'allStations',
      'stationIds',
      'expiresAt',
      'origins',
      'maxConnections',
    ].map((k) => [k, client[k]]),
  );
test('only explicit administrator approvals work; plaintext tokens never persist; station scope, origin, expiry and policy lease fail closed', (t) => {
  const s = environment(t),
    reader = new PublicAccess(s.store, s.config),
    station = s.store.stationList()[0].value;
  assert.equal(reader.authorize('unapproved-token'.repeat(3)), null);
  const { client, token } = s.clients.create(
    {
      name: 'Limited client',
      allStations: false,
      stationIds: [station.id],
      origins: ['https://approved.invalid'],
      expiresAt: new Date(s.now() + 5000).toISOString(),
    },
    'admin',
  );
  assert.equal(client.tokenHash, undefined);
  assert.equal(JSON.stringify(s.clients.list()).includes(token), false);
  assert.equal(readFileSync(s.config.publicAccessFile, 'utf8').includes(token), false);
  assert.equal(JSON.stringify(s.store.events()).includes(token), false);
  const approved = reader.authorize(token, 'https://approved.invalid');
  assert.ok(approved);
  assert.equal(reader.authorize(token, 'https://other.invalid'), null);
  assert.deepEqual(
    reader.select(approved, [station.name, station.id]).map((s) => s.id),
    [station.id],
  );
  assert.throws(() => reader.select(approved, ['Longva']), /ikke godkjent/);
  s.tick(5001);
  assert.equal(reader.authorize(token), null);
  assert.equal(s.clients.list()[0].status, 'expired');
  s.clients.update(client.id, client.revision, { ...valueOf(client), enabled: false }, 'admin');
  assert.equal(s.clients.list()[0].status, 'revoked');
  const forever = s.clients.create({ name: 'Forever' }, 'admin');
  assert.ok(reader.authorize(forever.token));
  s.tick(15001);
  assert.equal(reader.authorize(forever.token), null);
  s.clients.publish();
  assert.ok(reader.authorize(forever.token));
  const policy = JSON.parse(readFileSync(s.config.publicAccessFile, 'utf8'));
  policy.leaseUntil = 'invalid';
  writeFileSync(s.config.publicAccessFile, JSON.stringify(policy));
  assert.equal(reader.authorize(forever.token), null);
  s.clients.publish();
  unlinkSync(s.config.publicAccessFile);
  assert.equal(reader.authorize(forever.token), null);
});

test(
  'live Socket.IO approvals enforce origins, polling, shared connection limits, changed scope, expiry, rotation and missing policy',
  { timeout: 20000 },
  async (t) => {
    const s = environment(t),
      stations = s.store
        .stationList()
        .map((r) => r.value)
        .filter((v) => v.enabled && v.model !== 'Netatmo');
    let approved = s.clients.create(
      {
        name: 'Time limited browser',
        origins: ['https://approved.invalid'],
        maxConnections: 1,
        expiresAt: new Date(s.now() + 10000).toISOString(),
      },
      'admin',
    );
    const service = publicApp({ store: s.store, config: s.config }),
      server = createServer(service.app),
      sockets = [];
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const stop = service.attachSockets(server),
      url = `http://127.0.0.1:${server.address().port}`;
    const event = (socket, name) => once(socket, name, { signal: AbortSignal.timeout(5000) });
    const connect = (
      token,
      namespace = '/weather',
      origin = 'https://approved.invalid',
      transport = 'polling',
    ) => {
      const socket = io(url + namespace, {
        autoConnect: false,
        auth: { token },
        transports: [transport],
        extraHeaders: { Origin: origin },
        forceNew: true,
        reconnection: false,
        timeout: 2000,
      });
      sockets.push(socket);
      return socket;
    };
    try {
      const denied = connect(approved.token, '/weather', 'https://wrong.invalid', 'websocket'),
        deniedEvent = event(denied, 'connect_error');
      denied.connect();
      await deniedEvent;
      const socket = connect(approved.token),
        first = event(socket, 'weather:snapshot');
      socket.connect();
      assert.equal((await first)[0].stations.length, stations.length);
      const second = connect(approved.token, ''),
        limited = event(second, 'connect_error');
      second.connect();
      await limited;
      const changed = event(socket, 'weather:snapshot');
      approved.client = s.clients.update(
        approved.client.id,
        approved.client.revision,
        { ...valueOf(approved.client), allStations: false, stationIds: [stations[0].id] },
        'admin',
      );
      assert.deepEqual(
        (await changed)[0].stations.map((s) => s.id),
        [stations[0].id],
      );
      assert.equal(
        (
          await socket
            .timeout(2000)
            .emitWithAck('weather:history', { station: stations[1].id, date: '2026-10-19' })
        ).ok,
        false,
      );
      const expired = event(socket, 'disconnect');
      s.tick(10001);
      await expired;
      const forever = s.clients.create(
        { name: 'Forever socket', origins: ['https://approved.invalid'], maxConnections: 1 },
        'admin',
      );
      const current = connect(forever.token),
        opened = event(current, 'weather:snapshot');
      current.connect();
      await opened;
      const rotatedEvent = event(current, 'disconnect'),
        rotated = s.clients.rotate(forever.client.id, forever.client.revision, 'admin');
      await rotatedEvent;
      const replacement = connect(rotated.token),
        reopened = event(replacement, 'weather:snapshot');
      replacement.connect();
      await reopened;
      const lost = event(replacement, 'disconnect');
      unlinkSync(s.config.publicAccessFile);
      await lost;
    } finally {
      for (const socket of sockets) socket.disconnect();
      stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  },
);
test(
  'Socket.IO provides all approved weather fields and wind metadata, filters name/ID, protects legacy trends, and revokes open sessions',
  { timeout: 15000 },
  async (t) => {
    const s = environment(t),
      stations = s.store.stationList().map((r) => r.value);
    for (const [index, station] of stations.entries())
      ingest(
        s.store,
        station.id,
        observation(station.id, s.now(), {
          sequence: index + 1,
          measurements: { temperatureC: 20, humidityPct: 50, windSpeedMs: 6, windDirectionDeg: 270 },
        }),
      );
    const approved = s.clients.create(
      { name: 'Scoped system', allStations: false, stationIds: [stations[0].id], maxConnections: 3 },
      'admin',
    );
    const projection = publicProjection(s.store);
    projection.sync();
    const service = publicApp({ store: projection.store, config: s.config }),
      server = createServer(service.app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const stop = service.attachSockets(server),
      url = `http://127.0.0.1:${server.address().port}`;
    const sockets = [];
    try {
      const connect = (namespace, auth) => {
        const socket = io(url + namespace, {
          autoConnect: false,
          auth,
          transports: ['websocket'],
          reconnection: false,
          forceNew: true,
          timeout: 2000,
        });
        sockets.push(socket);
        return socket;
      };
      const bad = connect('/weather', { token: 'bad' }),
        rejected = once(bad, 'connect_error');
      bad.connect();
      await rejected;
      const socket = connect('/weather', { token: approved.token, stations: [stations[0].name] }),
        first = once(socket, 'weather:snapshot');
      socket.connect();
      const payload = (await first)[0];
      assert.equal(payload.schema, 'wg-weather-1');
      assert.equal(payload.stations.length, 1);
      assert.equal(payload.stations[0].wind.toDegrees, 90);
      assert.equal(payload.stations[0].wind.beaufort, 4);
      assert.equal(payload.stations[0].measurements.temperatureC, 20);
      assert.ok('dewPointC' in payload.stations[0].derived);
      assert.equal(JSON.stringify(payload).includes('tokenHash'), false);
      let answer = await socket.emitWithAck('weather:get', { stations: [stations[1].id] });
      assert.equal(answer.ok, false);
      answer = await socket.emitWithAck('weather:get', { stations: [stations[0].id] });
      assert.equal(answer.data.stations.length, 1);
      const legacy = connect('', { token: approved.token }),
        legacyFirst = once(legacy, 'file-content');
      legacy.connect();
      assert.deepEqual(Object.keys((await legacyFirst)[0]), [stations[0].key]);
      const trend = once(legacy, 'trendData');
      legacy.emit('fetchTrendData', { station: stations[1].key, date: '2026-10-19' });
      assert.ok((await trend)[0].error);
      const disconnected = once(socket, 'disconnect'),
        legacyGone = once(legacy, 'disconnect');
      s.clients.update(
        approved.client.id,
        approved.client.revision,
        { ...valueOf(approved.client), enabled: false },
        'admin',
      );
      await Promise.all([disconnected, legacyGone]);
    } finally {
      for (const socket of sockets) socket.disconnect();
      stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      projection.close();
    }
  },
);
test('HTTP current/files and admin connections API enforce separate AD roles, CSRF and station permissions', async (t) => {
  const s = environment(t),
    station = s.store.stationList()[0].value,
    app = controlApp({ ...s, directory: directory() }).app,
    agent = request.agent(app);
  assert.equal((await agent.get('/api/connections')).status, 401);
  const login = await agent
    .post('/api/login')
    .set('Origin', 'http://localhost:5173')
    .send({ username: 'test', password: 'valid-test-password' });
  assert.equal(
    (await agent.post('/api/connections').set('Origin', 'http://localhost:5173').send({ name: 'Blocked' }))
      .status,
    403,
  );
  const created = await agent
    .post('/api/connections')
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', login.body.csrf)
    .send({ name: 'Admin approved', allStations: false, stationIds: [station.id] });
  assert.equal(created.status, 201);
  const list = await agent.get('/api/connections');
  assert.equal(JSON.stringify(list.body).includes(created.body.token), false);
  const publicService = publicApp({ store: s.store, config: s.config });
  const current = await request(publicService.app)
    .get('/weather/current')
    .set('Authorization', `Bearer ${created.body.token}`);
  assert.deepEqual(Object.keys(current.body), [station.key]);
  assert.equal(
    (
      await request(publicService.app)
        .get('/files/Longva/flemsoy-wd.txt')
        .set('Authorization', `Bearer ${created.body.token}`)
    ).status,
    404,
  );
  const operator = request.agent(controlApp({ ...s, directory: directory(['operator']) }).app);
  await operator
    .post('/api/login')
    .set('Origin', 'http://localhost:5173')
    .send({ username: 'test', password: 'valid-test-password' });
  assert.equal((await operator.get('/api/connections')).status, 403);
  const old = created.body.token,
    rotated = s.clients.rotate(created.body.client.id, created.body.client.revision, 'admin');
  const access = new PublicAccess(s.store, s.config);
  assert.equal(access.authorize(old), null);
  assert.ok(access.authorize(rotated.token));
});
