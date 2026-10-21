import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import request from 'supertest';
import { setup, directory, approvePublicToken } from './helpers.js';
import { CertificateManager } from '../server/certificates.js';
import { CertificateIssuer } from '../server/pki.js';
import { controlApp, publicApp } from '../server/app.js';
import { startWorkerWhenReady } from '../server/worker.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, createConnection } from 'node:net';
import { writeFileSync } from 'node:fs';
import mqtt from 'mqtt';

const years = (amount) => ({ amount, unit: 'years' });
function managed(t) {
  const context = setup(t),
    root = join(context.store.root, 'certificates');
  Object.assign(context.config, {
    root: context.store.root,
    certificateRoot: root,
    issuerKeyFile: join(root, 'client-ca.key'),
    issuerCaFile: join(root, 'client-ca.pem'),
    firmwarePublicKeyFile: join(root, 'firmware-signing-public.pem'),
  });
  const manager = new CertificateManager({ store: context.store, config: context.config });
  return { ...context, manager, root };
}
const initial = {
  caValidity: years(50),
  validity: years(1),
  names: ['wg-api.skrg.no', '172.30.30.100', '83.243.191.64'],
};
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('State transition did not finish');
};

test('empty startup creates no certificates; panel initialization supports 50-year certificates, IP SAN, key preservation and minimal role publication', async (t) => {
  const { store, config, manager, root } = managed(t);
  assert.equal(
    manager.status().certificates.every((c) => c.missing),
    true,
  );
  assert.equal(existsSync(join(root, 'client-ca.key')), false);
  await manager.initialize({ ...initial, validity: years(50) }, 'admin');
  const ca = new X509Certificate(readFileSync(config.issuerCaFile)),
    server = new X509Certificate(readFileSync(join(root, 'server.pem')));
  assert.ok(new Date(ca.validTo).getUTCFullYear() - new Date(ca.validFrom).getUTCFullYear() >= 49);
  assert.ok(Date.parse(server.validTo) <= Date.parse(ca.validTo));
  assert.ok(new Date(server.validTo).getUTCFullYear() >= new Date().getUTCFullYear() + 49);
  for (const ip of ['172.30.30.100', '83.243.191.64']) assert.equal(server.checkIP(ip), ip);
  assert.equal(server.checkHost('broker'), 'broker');
  assert.deepEqual(server.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  const key = readFileSync(config.issuerKeyFile);
  await manager.initialize(initial, 'admin');
  assert.deepEqual(readFileSync(config.issuerKeyFile), key);
  for (const role of ['worker', 'broker', 'public']) {
    assert.equal(existsSync(join(root, 'roles', role, 'client-ca.key')), false);
    assert.equal(existsSync(join(root, 'roles', role, 'firmware-signing.key')), false);
  }
  assert.equal(existsSync(join(root, 'roles', 'public', 'server.key')), false);
  assert.equal(existsSync(join(root, 'roles', 'worker', 'server.key')), false);
  assert.equal(existsSync(join(root, 'roles', 'broker', 'worker.key')), false);
  const issuer = new CertificateIssuer({ store, keyFile: config.issuerKeyFile, caFile: config.issuerCaFile });
  const device = await issuer.issue(store.stationList()[0].value.id, years(50)),
    leaf = new X509Certificate(device.certificate);
  assert.ok(Date.parse(leaf.validTo) <= Date.parse(ca.validTo));
  assert.ok(new Date(leaf.validTo).getUTCFullYear() >= new Date().getUTCFullYear() + 49);
  assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.2']);
  assert.equal(JSON.stringify(manager.status()).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(store.events()).includes('PRIVATE KEY'), false);
  assert.throws(() =>
    manager.stage({ type: 'server', validity: years(51), names: ['wg-api.skrg.no'] }, 'admin'),
  );
  assert.equal(manager.pending(), null);
});

test('certificate trial rolls back across process restart, keeps its key and rejects late confirmation', async (t) => {
  const { store, config, manager, root, tick } = managed(t);
  await manager.initialize(initial, 'admin');
  const previous = readFileSync(join(root, 'server.pem')),
    key = readFileSync(join(root, 'server.key'));
  const change = await manager.stage(
    { type: 'server', validity: years(3), names: ['wg-api.skrg.no', '192.168.8.1'] },
    'admin',
  );
  assert.deepEqual(readFileSync(join(root, 'server.pem')), previous);
  manager.test(change.id, 'admin');
  assert.notDeepEqual(readFileSync(join(root, 'server.pem')), previous);
  tick(300001);
  const restarted = new CertificateManager({ store, config });
  assert.equal(restarted.pending(), null);
  assert.deepEqual(readFileSync(join(root, 'server.pem')), previous);
  assert.deepEqual(readFileSync(join(root, 'roles/broker/server.pem')), previous);
  assert.deepEqual(readFileSync(join(root, 'server.key')), key);
  assert.throws(() => restarted.confirm(change.id, 'admin'), { status: 409 });
  const next = await restarted.stage(
    { type: 'server', validity: years(2), names: ['wg-api.skrg.no'] },
    'admin',
  );
  restarted.test(next.id, 'admin');
  restarted.confirm(next.id, 'admin');
  tick(300001);
  restarted.sweep();
  assert.notDeepEqual(readFileSync(join(root, 'server.pem')), previous);
});

test('HTTPS and DB identities have distinct keys and correct usages; rejected CA shortening preserves active identities', async (t) => {
  const { manager, root } = managed(t);
  await manager.initialize(initial, 'admin');
  for (const [type, identities, eku] of [
    ['https', ['weathergateway.skrg.no', 'wg-api.skrg.no'], '1.3.6.1.5.5.7.3.1'],
    ['database-server', ['172.29.50.40'], '1.3.6.1.5.5.7.3.1'],
    ['database-client', [], '1.3.6.1.5.5.7.3.2'],
  ]) {
    const change = await manager.stage({ type, validity: years(5), names: identities }, 'admin');
    manager.test(change.id, 'admin');
    manager.confirm(change.id, 'admin');
    const result = manager.export(type, 'admin'),
      cert = new X509Certificate(result.certificate);
    assert.deepEqual(cert.keyUsage, [eku]);
    assert.equal(cert.checkHost('broker'), undefined);
    if (type === 'database-server') assert.equal(cert.checkIP('172.29.50.40'), '172.29.50.40');
  }
  const caKey = readFileSync(join(root, 'client-ca.key'));
  await assert.rejects(
    manager.stage({ type: 'ca', validity: years(1), names: [] }, 'admin'),
    /eksisterende tjenestesertifikat/,
  );
  assert.equal(manager.pending(), null);
  const change = await manager.stage({ type: 'ca', validity: years(50), names: [] }, 'admin');
  manager.test(change.id, 'admin');
  manager.confirm(change.id, 'admin');
  assert.deepEqual(readFileSync(join(root, 'client-ca.key')), caKey);
  assert.notDeepEqual(readFileSync(join(root, 'https.key')), readFileSync(join(root, 'database-server.key')));
});

test('PKI API requires AD administrator, origin and CSRF; ESP duration and exports work through the panel API', async (t) => {
  const { store, config, manager } = managed(t);
  const issuer = new CertificateIssuer({ store, keyFile: config.issuerKeyFile, caFile: config.issuerCaFile });
  const app = controlApp({
    store,
    config,
    directory: directory(),
    certificates: issuer,
    certificateManager: manager,
  }).app;
  await request(app).get('/api/pki').expect(401);
  const agent = request.agent(app),
    login = await agent
      .post('/api/login')
      .set('Origin', 'http://localhost:5173')
      .send({ username: 'test', password: 'valid-test-password' })
      .expect(200);
  const post = (path, body) =>
    agent.post(path).set('Origin', 'http://localhost:5173').set('X-CSRF-Token', login.body.csrf).send(body);
  await agent.post('/api/pki/initialize').set('Origin', 'http://localhost:5173').send(initial).expect(403);
  await post('/api/pki/initialize', initial).expect(201);
  const exported = await post('/api/pki/export/worker', {}).expect(200);
  assert.match(exported.body.privateKey, /BEGIN PRIVATE KEY/);
  const issued = await post(`/api/devices/${store.stationList()[0].value.id}/certificate`, {
    validity: years(50),
  }).expect(200);
  assert.match(issued.body.firmwarePublicKey, /BEGIN PUBLIC KEY/);
  assert.ok(
    Date.parse(new X509Certificate(issued.body.certificate).validTo) > Date.now() + 49 * 365 * 86400000,
  );
  const readerApp = controlApp({
    store,
    config,
    directory: directory(['viewer']),
    certificateManager: manager,
  }).app;
  const reader = request.agent(readerApp);
  await reader
    .post('/api/login')
    .set('Origin', 'http://localhost:5173')
    .send({ username: 'test', password: 'valid-test-password' })
    .expect(200);
  await reader.get('/api/pki').expect(403);
  assert.equal(JSON.stringify(store.events()).includes(exported.body.privateKey), false);
});

test('MQTT worker waits without credentials, starts after issuance, and reconnects after renewal and rollback', async (t) => {
  const { store, manager, root } = managed(t),
    logs = [];
  let starts = 0,
    stops = 0;
  const stop = startWorkerWhenReady(
    store,
    {
      mqttCaFile: join(root, 'roles/worker/client-ca.pem'),
      mqttCertFile: join(root, 'roles/worker/worker.pem'),
      mqttKeyFile: join(root, 'roles/worker/worker.key'),
    },
    null,
    {
      interval: 20,
      logger: (entry) => logs.push(entry),
      start: () => {
        starts++;
        return async () => {
          stops++;
        };
      },
    },
  );
  t.after(stop);
  await waitFor(() => logs.some((e) => e.event === 'mqtt_waiting_for_certificates'));
  assert.equal(starts, 0);
  await manager.initialize(initial, 'admin');
  await waitFor(() => starts === 1);
  const change = await manager.stage({ type: 'worker', validity: years(3), names: [] }, 'admin');
  manager.test(change.id, 'admin');
  await waitFor(() => starts === 2);
  manager.rollback(change.id, 'admin');
  await waitFor(() => starts === 3);
  assert.equal(stops, 2);
});

test('public API denies generated tokens until administrator approval, then loads the approval without restart', async (t) => {
  const { store, manager, root } = managed(t);
  const config = { ...managedConfig(store), publicTokenFile: join(root, 'roles/public/read-token') };
  const app = publicApp({ store, config }).app;
  await request(app).get('/weather/current').set('Authorization', 'Bearer missing').expect(401);
  await manager.initialize(initial, 'admin');
  const token = readFileSync(join(root, 'read-token'), 'utf8');
  assert.equal(existsSync(config.publicTokenFile), false);
  writeFileSync(config.publicTokenFile, token);
  manager.publish();
  assert.equal(existsSync(config.publicTokenFile), false, 'old plaintext public token is removed');
  await request(app).get('/weather/current').set('Authorization', `Bearer ${token}`).expect(401);
  approvePublicToken(store, config, token.trim());
  await request(app).get('/weather/current').set('Authorization', `Bearer ${token}`).expect(200);
});

function managedConfig(store) {
  return {
    role: 'public',
    environment: store.environment,
    secureCookies: false,
    trustedProxies: [],
    publicToken: '',
  };
}

test(
  'real Mosquitto accepts panel-issued 50-year mTLS identities and denies missing credentials',
  { skip: !process.env.WG_MOSQUITTO_BIN, timeout: 20000 },
  async (t) => {
    const { manager, store, config, root } = managed(t);
    await manager.initialize({ ...initial, validity: years(50) }, 'admin');
    const issuer = new CertificateIssuer({
      store,
      keyFile: config.issuerKeyFile,
      caFile: config.issuerCaFile,
    });
    const identity = await issuer.issue(store.stationList()[0].value.id, years(50));
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const path = (value) => value.replaceAll('\\', '/');
    const conf = join(root, 'integration-mosquitto.conf');
    writeFileSync(
      conf,
      `listener ${port} 127.0.0.1\nallow_anonymous false\nrequire_certificate true\nuse_identity_as_username true\ncafile ${path(join(root, 'roles/broker/client-ca.pem'))}\ncertfile ${path(join(root, 'roles/broker/server.pem'))}\nkeyfile ${path(join(root, 'roles/broker/server.key'))}\nacl_file ${path(store.safe('system/mqtt/acl'))}\npersistence false\nlog_dest stdout\n`,
    );
    const broker = spawn(process.env.WG_MOSQUITTO_BIN, ['-c', conf], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    broker.stderr.on('data', (data) => (errors = (errors + data).slice(-2000)));
    const clients = [];
    const connect = async (bundle) => {
      const client = mqtt.connect({
        protocol: 'mqtts',
        host: '127.0.0.1',
        port,
        servername: 'wg-api.skrg.no',
        protocolVersion: 5,
        reconnectPeriod: 0,
        connectTimeout: 2000,
        rejectUnauthorized: true,
        ca: identity.ca,
        ...(bundle ? { cert: bundle.certificate, key: bundle.privateKey } : {}),
      });
      clients.push(client);
      client.on('error', () => {});
      await once(client, 'connect');
      return client;
    };
    try {
      await waitFor(() => {
        assert.equal(broker.exitCode, null, errors);
        return true;
      });
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) {
        ready = await new Promise((resolve) => {
          const socket = createConnection({ host: '127.0.0.1', port });
          socket.once('connect', () => {
            socket.destroy();
            resolve(true);
          });
          socket.once('error', () => resolve(false));
        });
        if (!ready) await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(ready, errors);
      await assert.rejects(connect(null));
      const worker = await connect(manager.export('worker', 'test'));
      const topic = `wg/v1/test/stations/${identity.stationId}/telemetry`;
      await worker.subscribeAsync(topic, { qos: 1 });
      const received = once(worker, 'message'),
        device = await connect(identity);
      await device.publishAsync(topic, 'fifty-year-certificate-check', { qos: 1 });
      const [, payload] = await received;
      assert.equal(payload.toString(), 'fifty-year-certificate-check');
    } finally {
      for (const client of clients) client.end(true);
      if (broker.exitCode === null) {
        const exited = once(broker, 'exit');
        broker.kill('SIGKILL');
        await exited;
      }
    }
  },
);
