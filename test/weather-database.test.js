import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, observation, directory } from './helpers.js';
import { databaseSchema, databaseColumns } from '../server/schema.js';
import { WeatherDatabase } from '../server/weather-database.js';
import { databaseStatus, databaseTargetHash } from '../server/database-queue.js';
import { ingest } from '../server/observations.js';
import { Store } from '../server/store.js';
import { controlApp } from '../server/app.js';
import { publicProjection } from '../server/public-projection.js';
import { maintain } from '../server/maintenance.js';
import { privateDatabaseLookup } from '../server/database-transport.js';
import { configuration } from '../server/bootstrap.js';

test('direct LAN is the default and requires an exact allowed private endpoint without TLS or VPN', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  const target = configure(state.store, station.id),
    { writer, fake } = backend(t, state, {
      databaseLanEndpoints: ['db.example.test:3306', '8.8.8.8:3306'],
      databaseCaFile: 'missing-ca-file-must-not-be-read-in-lan-mode',
    });
  const lan = databaseSchema.parse({ ...target, transport: undefined });
  assert.equal(lan.transport, 'lan');
  assert.equal(databaseSchema.parse({ ...target, transport: 'vpn' }).transport, 'lan');
  await writer.probe(lan);
  assert.equal(Object.hasOwn(fake.pools[0], 'ssl'), false);
  assert.equal(typeof fake.pools[0].stream, 'function');
  await assert.rejects(writer.probe({ ...lan, port: 3307 }), /WG_DB_LAN_ENDPOINTS/);
  await assert.rejects(writer.probe({ ...lan, host: 'unknown.example.test' }), /WG_DB_LAN_ENDPOINTS/);
  await assert.rejects(writer.probe({ ...lan, host: '8.8.8.8' }), /privat IP/);
  assert.equal(fake.pools.length, 1);
  assert.deepEqual(
    configuration({ WG_DB_LAN_ENDPOINTS: ' db.example.test:3306, 127.0.0.1:13306, ' }).databaseLanEndpoints,
    ['db.example.test:3306', '127.0.0.1:13306'],
  );
  assert.deepEqual(configuration({ WG_DB_TUNNEL_ENDPOINTS: 'db.example.test:3306' }).databaseLanEndpoints, [
    'db.example.test:3306',
  ]);
  assert.deepEqual(
    configuration({ WG_DB_LAN_ENDPOINTS: '', WG_DB_TUNNEL_ENDPOINTS: 'db.example.test:3306' })
      .databaseLanEndpoints,
    [],
  );
});

test('LAN DNS lookup rejects public addresses in the actual socket lookup, including mixed results', async () => {
  const run = (address, family, all = false) =>
    new Promise((resolve, reject) =>
      privateDatabaseLookup(
        'db.example.test',
        { all },
        (error, result, resultFamily) => (error ? reject(error) : resolve({ result, resultFamily })),
        (_host, _options, callback) => callback(null, address, family),
      ),
    );
  assert.deepEqual(await run('10.20.30.40', 4), { result: '10.20.30.40', resultFamily: 4 });
  const addresses = [
    { address: '10.20.30.40', family: 4 },
    { address: 'fd00::1', family: 6 },
  ];
  assert.deepEqual((await run(addresses, undefined, true)).result, addresses);
  await assert.rejects(run('8.8.8.8', 4), { code: 'DB_LAN_ADDRESS_NOT_PRIVATE' });
  await assert.rejects(
    run(
      [
        { address: '10.20.30.40', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 },
      ],
      undefined,
      true,
    ),
    { code: 'DB_LAN_ADDRESS_NOT_PRIVATE' },
  );
  await assert.rejects(run([], undefined, true), { code: 'DB_LAN_ADDRESS_NOT_PRIVATE' });
});

test('TLS failure never retries through LAN or removes certificate validation', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value,
    target = configure(state.store, station.id);
  const options = [];
  const writer = new WeatherDatabase(
    state.store,
    {
      ...state.config,
      databaseAllowlist: ['wg_dev_skodje'],
      databasePasswords: { WG_DB_PASSWORD: 'test' },
      databaseLanEndpoints: ['db.example.test:3306'],
    },
    {
      poolFactory: (config) => {
        options.push(config);
        return {
          async end() {},
          async getConnection() {
            throw Object.assign(new Error('no SSL'), { code: 'HANDSHAKE_NO_SSL_SUPPORT' });
          },
        };
      },
    },
  );
  t.after(() => writer.close());
  await assert.rejects(writer.probe(target), /HANDSHAKE_NO_SSL_SUPPORT/);
  assert.equal(options.length, 1);
  assert.equal(options[0].ssl.rejectUnauthorized, true);
  assert.equal(Object.hasOwn(options[0], 'stream'), false);
});

test('switching TLS to confirmed LAN transport preserves queued observations and their destination', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  const initial = configure(state.store, station.id);
  const legacy = { ...initial };
  delete legacy.transport;
  delete legacy.stationNameColumn;
  assert.equal(databaseTargetHash(initial), databaseTargetHash(legacy));
  ingest(state.store, station.id, observation(station.id, state.now()));
  const { writer, fake } = backend(t, state, { databaseLanEndpoints: ['db.example.test:3306'] });
  configure(state.store, station.id, { transport: 'lan' });
  assert.equal(databaseStatus(state.store)[0].paused, 0);
  await writer.drain();
  assert.equal(fake.rows.size, 1);
  assert.equal(databaseStatus(state.store)[0].pending, 0);
});

test('the optional station name column satisfies the existing Vatne table without changing other station payloads', async (t) => {
  const state = setup(t),
    station = state.store.stationList().find((item) => item.value.key === 'Vatne').value;
  const target = configure(state.store, station.id, { stationNameColumn: 'station_name' });
  const { writer, fake } = backend(t, state);
  fake.columns.push({ name: 'station_name', type: 'varchar', nullable: 'NO', defaultValue: null, extra: '' });
  await assert.rejects(writer.probe({ ...target, stationNameColumn: null }), /påkrevd/);
  assert.equal((await writer.probe(target)).database, 'ok');
  ingest(state.store, station.id, observation(station.id, state.now()));
  await writer.drain();
  assert.equal([...fake.rows.values()][0].station_name, station.name);
  assert.equal(databaseSchema.safeParse({ ...target, stationNameColumn: 'temperature' }).success, false);
});

function configure(store, stationId, overrides = {}) {
  const scope = `database:${stationId}`,
    current = store.current(scope);
  const target = databaseSchema.parse({
    ...current.value,
    enabled: true,
    host: 'db.example.test',
    database: 'wg_dev_skodje',
    user: 'writer',
    transport: 'tls',
    ...overrides,
  });
  const change = store.propose(scope, target, current.revision, 'test-admin');
  store.begin(change.id, 'test-admin');
  store.health(change.id, true, { database: 'ok' });
  store.confirm(change.id, 'test-admin');
  return target;
}
function backend(t, state, options = {}) {
  const calls = [],
    rows = new Map(),
    pools = [];
  const columns = [
    ...['station_id', 'date', 'time'].map((name) => ({
      name,
      type: name === 'station_id' ? 'varchar' : name,
      nullable: 'NO',
      defaultValue: null,
      extra: '',
    })),
    ...Object.values(databaseColumns).map((name) => ({
      name,
      type: 'decimal',
      nullable: 'YES',
      defaultValue: null,
      extra: '',
    })),
  ];
  const fake = {
    calls,
    rows,
    pools,
    columns,
    fail: false,
    commitThenFail: false,
    missingUnique: false,
    mode: 'STRICT_TRANS_TABLES',
    released: 0,
    destroyed: 0,
  };
  const writer = new WeatherDatabase(
    state.store,
    {
      ...state.config,
      databaseAllowlist: ['wg_dev_skodje', 'wg_dev_other'],
      databasePasswords: { WG_DB_PASSWORD: 'never-log-this-password' },
      databaseLanEndpoints: ['db.example.test:3306'],
      ...options,
    },
    {
      logger: (entry) => calls.push({ log: entry }),
      poolFactory: (config) => {
        pools.push(config);
        return {
          async end() {},
          async getConnection() {
            return {
              release() {
                fake.released++;
              },
              destroy() {
                fake.destroyed++;
              },
              async execute({ sql }, values) {
                calls.push({ sql, values });
                if (sql.includes('information_schema.COLUMNS')) return [fake.columns];
                if (sql.includes('information_schema.STATISTICS'))
                  return [
                    fake.missingUnique
                      ? []
                      : ['station_id', 'date', 'time'].map((columnName) => ({
                          name: 'PRIMARY',
                          columnName,
                          prefixLength: null,
                        })),
                  ];
                if (sql.includes('@@SESSION.sql_mode')) return [[{ mode: fake.mode }]];
                if (sql.startsWith('SELECT')) return [[]];
                if (!sql.startsWith('INSERT INTO wx_data')) throw new Error('Unexpected SQL');
                const error = () =>
                  Object.assign(new Error('private database password never-log-this-password and SQL text'), {
                    code: 'ECONNRESET',
                    fatal: true,
                  });
                if (fake.fail) throw error();
                const names = sql
                  .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
                  .split(',')
                  .map((name) => name.replaceAll('`', ''));
                const row = Object.fromEntries(names.map((name, index) => [name, values[index]]));
                const key = JSON.stringify([row.station_id, row.date, row.time]);
                if (!rows.has(key)) rows.set(key, row);
                if (fake.commitThenFail) {
                  fake.commitThenFail = false;
                  throw error();
                }
                return [{ affectedRows: 1 }];
              },
            };
          },
        };
      },
    },
  );
  t.after(() => writer.close());
  return { writer, fake };
}

test('database delivery is opt-in; inline secrets never enter the local weather database', async (t) => {
  const state = setup(t),
    { writer, fake } = backend(t, state);
  const station = state.store.stationList()[0].value;
  ingest(state.store, station.id, observation(station.id, state.now()));
  await writer.drain();
  assert.equal(fake.pools.length, 0);
  assert.equal(state.store.db.prepare('SELECT COUNT(*) AS n FROM database_outbox').get().n, 0);
  assert.equal(JSON.stringify(state.store.configurations()).includes('never-log-this-password'), false);
});

test('ingestion queues one durable row per configured interval with Oslo time, km/h, missing pressure and daily extremes', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  configure(state.store, station.id);
  const input = observation(station.id, state.now());
  delete input.measurements.pressureHpa;
  ingest(state.store, station.id, input);
  ingest(state.store, station.id, input);
  state.tick(30000);
  ingest(state.store, station.id, { ...input, sequence: 2, observedAt: new Date(state.now()).toISOString() });
  const entries = state.store.db.prepare('SELECT * FROM database_outbox').all();
  assert.equal(entries.length, 1);
  const row = JSON.parse(entries[0].row_json);
  assert.equal(row.station_id, station.key);
  assert.equal(row.date, '2026-10-19');
  assert.equal(row.time, '12:00:00');
  assert.equal(row.barometer, null);
  assert.equal(row.average_windspeed, 14.4);
  assert.equal(row.gust_windspeed, 25.2);
  assert.equal(row.max_gust_current_day, 25.2);
  assert.equal(row.max_daily_temperature, 20);
  assert.equal(row.daily_rainfall, 3.4);
});

test('failure to persist the delivery queue rolls back the observation and its aggregates', (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  configure(state.store, station.id);
  state.store.db.exec(
    "CREATE TRIGGER refuse_queue BEFORE INSERT ON database_outbox BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END",
  );
  assert.throws(() => ingest(state.store, station.id, observation(station.id, state.now())));
  assert.equal(state.store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 0);
  assert.equal(state.store.db.prepare('SELECT COUNT(*) AS n FROM rollups').get().n, 0);
  assert.equal(state.store.db.prepare('SELECT COUNT(*) AS n FROM rain_state').get().n, 0);
});

test('global and per-station logging pauses block new rows and delivery, preserve backlog and resume at the configured interval', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  configure(state.store, station.id, { intervalSeconds: 10 });
  const { writer, fake } = backend(t, state);
  const apply = (scope, patch) => {
    const current = state.store.current(scope),
      change = state.store.propose(scope, { ...current.value, ...patch }, current.revision, 'test');
    state.store.begin(change.id, 'test');
    state.store.health(change.id, true, {});
    state.store.confirm(change.id, 'test');
  };
  let sequence = 0;
  const send = () =>
    ingest(state.store, station.id, observation(station.id, state.now(), { sequence: ++sequence }));
  send();
  assert.equal(databaseStatus(state.store)[0].pending, 1);
  apply('gateway', { databaseLoggingEnabled: false });
  await writer.drain();
  assert.equal(fake.pools.length, 0);
  state.tick(11000);
  send();
  assert.equal(databaseStatus(state.store)[0].pending, 1);
  apply('gateway', { databaseLoggingEnabled: true });
  apply(`database:${station.id}`, { loggingEnabled: false });
  await writer.drain();
  assert.equal(fake.rows.size, 0);
  state.tick(11000);
  send();
  assert.equal(databaseStatus(state.store)[0].pending, 1);
  apply(`database:${station.id}`, { loggingEnabled: true });
  await writer.drain();
  assert.equal(fake.rows.size, 1);
  send();
  state.tick(9000);
  send();
  assert.equal(databaseStatus(state.store)[0].pending, 1);
  state.tick(1000);
  send();
  assert.equal(databaseStatus(state.store)[0].pending, 2);
  await writer.drain();
  assert.equal(fake.rows.size, 3);
});

test('admin database passwords are encrypted in the settings database and worker receives only its dedicated decryption key', async (t) => {
  const state = setup(t);
  state.config.certificateRoot = state.store.safe('certificates');
  const station = state.store.stationList()[0].value,
    { writer, fake } = backend(t, state);
  const reference = writer.savePassword('private-admin-db-password', 'admin');
  const target = configure(state.store, station.id, { passwordSecret: reference });
  assert.ok(!JSON.stringify(state.store.configurations()).includes('private-admin-db-password'));
  assert.ok(
    !JSON.stringify(state.store.db.prepare('SELECT * FROM settings_secrets').all()).includes(
      'private-admin-db-password',
    ),
  );
  await writer.probe(target);
  assert.equal(fake.pools[0].password, 'private-admin-db-password');
});

test('schema tests execute only reads, verify TLS and accept the original Weather Display defaults', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  const target = configure(state.store, station.id),
    { writer, fake } = backend(t, state);
  assert.equal((await writer.probe(target)).writePerformed, false);
  assert.ok(fake.calls.every((call) => call.sql?.startsWith('SELECT')));
  assert.equal(fake.pools[0].ssl.rejectUnauthorized, true);
  assert.equal(fake.pools[0].ssl.verifyIdentity, true);
  assert.equal(fake.pools[0].ssl.minVersion, 'TLSv1.2');
  assert.ok(fake.pools[0].maxIdle < fake.pools[0].connectionLimit);
  fake.missingUnique = true;
  await assert.rejects(writer.probe(target), /unik nøkkel/);
  fake.missingUnique = false;
  fake.columns.find((column) => column.name === 'barometer').nullable = 'NO';
  fake.columns.find((column) => column.name === 'barometer').defaultValue = '0';
  assert.ok((await writer.probe(target)).defaultedColumns.includes('barometer'));
});

test('development refuses production targets even if allowlisted, and an unlisted target never opens a socket', async (t) => {
  const state = setup(t, 'development'),
    station = state.store.stationList()[0].value;
  const target = configure(state.store, station.id),
    { writer, fake } = backend(t, state, { databaseAllowlist: ['wg_dev_skodje', 'weather_production'] });
  await assert.rejects(writer.probe({ ...target, database: 'weather_production' }), /wg_dev_/);
  await assert.rejects(writer.probe({ ...target, database: 'wg_dev_unknown' }), /ikke tillatt/);
  assert.equal(fake.pools.length, 0);
});

test('an uncertain remote commit is retried after restart without replacing the first observation', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  configure(state.store, station.id);
  const { writer, fake } = backend(t, state);
  ingest(state.store, station.id, observation(station.id, state.now()));
  fake.commitThenFail = true;
  await writer.drain();
  assert.equal(fake.rows.size, 1);
  assert.equal(databaseStatus(state.store)[0].pending, 1);
  const logged = fake.calls.filter((call) => call.log);
  assert.equal(JSON.stringify(logged).includes('never-log-this-password'), false);
  assert.equal(logged[0].log.code, 'ECONNRESET');
  const reopened = new Store({ root: state.store.root, environment: 'test', clock: state.now });
  state.tick(3000);
  const originalStore = writer.store;
  try {
    writer.store = reopened;
    await writer.drain();
    assert.equal(databaseStatus(reopened)[0].pending, 0);
    assert.equal(fake.rows.size, 1);
    assert.equal(fake.destroyed, 1);
    assert.equal(databaseStatus(reopened)[0].lastDeliveredAt, Date.UTC(2026, 9, 19, 10));
  } finally {
    writer.store = originalStore;
    reopened.close();
  }
});

test('a failed oldest row blocks later rows; pending data survives retention and target changes', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  configure(state.store, station.id);
  const { writer, fake } = backend(t, state);
  ingest(state.store, station.id, observation(station.id, state.now()));
  state.tick(60000);
  ingest(state.store, station.id, observation(station.id, state.now(), { sequence: 2 }));
  fake.fail = true;
  await writer.drain();
  assert.equal(fake.calls.filter((call) => call.sql?.startsWith('INSERT')).length, 1);
  fake.fail = false;
  await writer.drain();
  assert.equal(fake.rows.size, 0);
  configure(state.store, station.id, { database: 'wg_dev_other' });
  state.tick(10000);
  await writer.drain();
  assert.equal(fake.rows.size, 0);
  const status = databaseStatus(state.store)[0];
  assert.equal(status.pending, 2);
  assert.equal(status.paused, 2);
  state.tick(366 * 86400000);
  maintain(state.store);
  assert.equal(state.store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 0);
  assert.equal(databaseStatus(state.store)[0].pending, 2);
});

test('an unconfirmed database trial produces no queue entries and rolls back after the deadline', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  const scope = `database:${station.id}`,
    current = state.store.current(scope);
  const target = databaseSchema.parse({
    ...current.value,
    enabled: true,
    host: 'db.example.test',
    database: 'wg_dev_skodje',
    user: 'writer',
  });
  const draft = state.store.propose(scope, target, current.revision, 'admin');
  state.store.begin(draft.id, 'admin');
  state.store.health(draft.id, true, { database: 'ok' });
  ingest(state.store, station.id, observation(station.id, state.now()));
  assert.equal(state.store.db.prepare('SELECT COUNT(*) AS n FROM database_outbox').get().n, 0);
  state.tick(300001);
  state.store.sweep();
  assert.equal(state.store.current(scope).value.enabled, false);
  assert.equal(state.store.getChange(draft.id).state, 'rolled_back');
});

test('database settings, queue payloads and secrets are excluded from the public projection', (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value;
  configure(state.store, station.id);
  ingest(state.store, station.id, observation(station.id, state.now()));
  const projection = publicProjection(state.store);
  projection.sync();
  const publicStore = new Store({ root: state.store.safe('public'), environment: 'test', readonly: true });
  try {
    assert.equal(publicStore.configurations('database:').length, 0);
    assert.equal(publicStore.db.prepare('SELECT COUNT(*) AS n FROM database_outbox').get().n, 0);
    assert.equal(JSON.stringify(publicStore.configurations()).includes('db.example.test'), false);
  } finally {
    publicStore.close();
    projection.close();
  }
});

test('only administrators can view, test or change database targets, and API tests precede confirmation', async (t) => {
  const state = setup(t),
    station = state.store.stationList()[0].value,
    { writer, fake } = backend(t, state);
  const scope = `database:${station.id}`,
    current = state.store.current(scope);
  const target = databaseSchema.parse({
    ...current.value,
    enabled: true,
    host: 'db.example.test',
    database: 'wg_dev_skodje',
    user: 'writer',
  });
  for (const roles of [['viewer'], ['operator'], ['administrator']]) {
    const { app } = controlApp({ ...state, directory: directory(roles), databaseWriter: writer });
    const agent = request.agent(app),
      session = await agent
        .post('/api/login')
        .set('Origin', 'http://localhost:5173')
        .send({ username: 'test', password: 'valid-test-password' })
        .expect(200);
    const post = (path, body) =>
      agent
        .post(path)
        .set('Origin', 'http://localhost:5173')
        .set('X-CSRF-Token', session.body.csrf)
        .send(body);
    const response = await agent.get('/api/state').expect(200);
    assert.equal(response.body.databases.length, roles[0] === 'administrator' ? 4 : 0);
    assert.equal(JSON.stringify(response.body).includes('never-log-this-password'), false);
    if (roles[0] !== 'administrator') {
      await post(`/api/databases/${station.id}/test`, target).expect(403);
      await post('/api/changes', { scope, revision: current.revision, value: target }).expect(403);
      continue;
    }
    const draft = await post('/api/changes', { scope, revision: current.revision, value: target }).expect(
      201,
    );
    await post(`/api/changes/${draft.body.id}/test`, {}).expect(200);
    assert.equal(state.store.confirmedValue(scope).enabled, false);
    await post(`/api/changes/${draft.body.id}/confirm`, {}).expect(200);
    assert.equal(state.store.confirmedValue(scope).enabled, true);
    assert.ok(fake.calls.every((call) => call.sql?.startsWith('SELECT')));
  }
});
