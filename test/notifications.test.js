import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, observation, directory } from './helpers.js';
import { Notifications } from '../server/notifications.js';
import { CertificateManager } from '../server/certificates.js';
import { controlApp } from '../server/app.js';
import { ingest } from '../server/observations.js';
import request from 'supertest';
async function smtpServer(t, { security = 'none', identity, auth = false, reject = false } = {}) {
  const messages = [],
    logins = [],
    sockets = new Set();
  const handle = (socket, secured = security === 'tls') => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = '',
      data = false,
      body = '';
    const listener = (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            messages.push(body);
            body = '';
            data = false;
            socket.write('250 accepted\r\n');
          } else body += line + '\n';
          continue;
        }
        if (/^EHLO|^HELO/.test(line)) {
          socket.write(
            '250-localhost\r\n' +
              (security === 'starttls' && !secured ? '250-STARTTLS\r\n' : '') +
              (auth ? '250-AUTH PLAIN\r\n' : '') +
              '250 OK\r\n',
          );
        } else if (line === 'STARTTLS') {
          socket.write('220 ready\r\n');
          socket.removeListener('data', listener);
          const secure = new tls.TLSSocket(socket, {
            isServer: true,
            secureContext: tls.createSecureContext(identity),
          });
          handle(secure, true);
          return;
        } else if (line.startsWith('AUTH PLAIN')) {
          logins.push(Buffer.from(line.split(' ')[2] || '', 'base64').toString('utf8'));
          socket.write('235 authenticated\r\n');
        } else if (line.startsWith('MAIL FROM'))
          socket.write(reject ? '451 try later\r\n' : '250 sender\r\n');
        else if (line.startsWith('RCPT TO')) socket.write('250 recipient\r\n');
        else if (line === 'DATA') {
          data = true;
          socket.write('354 end with dot\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('250 OK\r\n');
      }
    };
    socket.on('data', listener);
  };
  const connect = (socket) => {
    handle(socket);
    socket.write('220 localhost test SMTP\r\n');
  };
  const server = security === 'tls' ? tls.createServer(identity, connect) : net.createServer(connect);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  });
  return { port: server.address().port, messages, logins };
}
function service(t) {
  const s = setup(t);
  s.config.certificateRoot = join(s.store.root, 'certificates');
  return { ...s, service: new Notifications(s.store, s.config) };
}
function options(port) {
  return {
    enabled: true,
    recipients: ['test@example.invalid'],
    smtp: { host: '127.0.0.1', port, security: 'none', from: 'gateway@example.invalid', authEnabled: false },
    rules: [],
  };
}
function apply(s, config) {
  const current = s.store.current('notifications');
  const change = s.store.propose('notifications', config, current.revision, 'admin');
  s.store.begin(change.id, 'admin');
  s.store.health(change.id, true, { smtp: 'ok' });
  s.store.confirm(change.id, 'admin');
}
test('real SMTP supports custom port, no authentication/no TLS, optional credentials, encrypted password and explicit test mail', async (t) => {
  const s = service(t),
    server = await smtpServer(t, { auth: true });
  const settings = s.service.prepare({
    ...options(server.port),
    smtp: {
      ...options(server.port).smtp,
      authEnabled: true,
      user: 'smtp-test',
      password: 'smtp-private-test-only',
    },
  });
  assert.equal(JSON.stringify(s.store.current('notifications')).includes('smtp-private-test-only'), false);
  assert.equal(
    s.store.db
      .prepare('SELECT payload FROM settings_secrets')
      .get()
      .payload.includes('smtp-private-test-only'),
    false,
  );
  assert.equal((await s.service.verify(settings)).smtp, 'ok');
  assert.equal(server.messages.length, 0);
  assert.equal((await s.service.test(settings, 'admin')).sent, true);
  assert.equal(server.messages.length, 1);
  assert.ok(server.logins.some((v) => v.includes('smtp-test')));
  const anonymous = s.service.prepare(options(server.port));
  await s.service.test(anonymous, 'admin');
  assert.equal(server.messages.length, 2);
});
test('TLS and required STARTTLS validate the certificate; required STARTTLS never downgrades to plain SMTP', async (t) => {
  const s = service(t),
    root = s.config.certificateRoot;
  Object.assign(s.config, {
    issuerCaFile: join(root, 'client-ca.pem'),
    issuerKeyFile: join(root, 'client-ca.key'),
    firmwarePublicKeyFile: join(root, 'firmware-signing-public.pem'),
  });
  const manager = new CertificateManager({ store: s.store, config: s.config });
  await manager.initialize(
    {
      caValidity: { amount: 2, unit: 'years' },
      validity: { amount: 1, unit: 'years' },
      names: ['localhost', '127.0.0.1'],
    },
    'admin',
  );
  const identity = {
      key: readFileSync(join(root, 'server.key')),
      cert: readFileSync(join(root, 'server.pem')),
    },
    ca = readFileSync(s.config.issuerCaFile, 'utf8');
  for (const security of ['tls', 'starttls']) {
    const server = await smtpServer(t, { security, identity });
    const settings = s.service.prepare({
      ...options(server.port),
      smtp: { ...options(server.port).smtp, security, caCertificate: ca },
    });
    assert.equal((await s.service.verify(settings)).smtp, 'ok');
    await s.service.test(settings, 'admin');
    assert.equal(server.messages.length, 1);
  }
  const plain = await smtpServer(t);
  await assert.rejects(
    s.service.verify(
      s.service.prepare({
        ...options(plain.port),
        smtp: { ...options(plain.port).smtp, security: 'starttls' },
      }),
    ),
    /SMTP-test feilet/,
  );
  assert.equal(plain.messages.length, 0);
});
test('outage notifications deduplicate, retry persistently, recover and respect the confirmed enable switch', async (t) => {
  const s = service(t),
    server = await smtpServer(t),
    stationId = s.store.stationList()[0].value.id;
  const settings = s.service.prepare({
    ...options(server.port),
    rules: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Data eldre enn 5 sekunder',
        kind: 'data_age',
        thresholdSeconds: 5,
        stationIds: [stationId],
        repeatSeconds: 0,
      },
    ],
  });
  apply(s, settings);
  ingest(s.store, stationId, observation(stationId, s.now()));
  s.tick(6000);
  await s.service.tick();
  assert.equal(server.messages.length, 1);
  await s.service.tick();
  assert.equal(server.messages.length, 1);
  ingest(s.store, stationId, observation(stationId, s.now(), { sequence: 2 }));
  await s.service.tick();
  assert.equal(server.messages.length, 2);
  apply(s, { ...settings, enabled: false });
  s.tick(6000);
  await s.service.tick();
  assert.equal(server.messages.length, 2);
  const rejected = await smtpServer(t, { reject: true });
  apply(s, s.service.prepare({ ...settings, smtp: { ...settings.smtp, port: rejected.port } }));
  await s.service.tick();
  const pending = s.store.db.prepare("SELECT * FROM notification_outbox WHERE state='queued'").get();
  assert.ok(pending);
  assert.equal(pending.attempts, 1);
  assert.ok(pending.next_attempt > s.now());
  assert.equal(JSON.stringify(s.store.events()).includes('smtp-private-test-only'), false);
});
test('notification settings and SMTP tests require administrator, same origin and CSRF', async (t) => {
  const s = service(t),
    app = controlApp({ ...s, directory: directory(), notifications: s.service }).app,
    agent = request.agent(app);
  assert.equal((await agent.get('/api/notifications')).status, 401);
  const login = await agent
    .post('/api/login')
    .set('Origin', 'http://localhost:5173')
    .send({ username: 'test', password: 'valid-test-password' });
  assert.equal(
    (
      await agent
        .post('/api/notifications')
        .set('Origin', 'http://localhost:5173')
        .send({ revision: 1, value: {} })
    ).status,
    403,
  );
  const saved = await agent
    .post('/api/notifications')
    .set('Origin', 'http://localhost:5173')
    .set('X-CSRF-Token', login.body.csrf)
    .send({ revision: 1, value: { enabled: false } });
  assert.equal(saved.status, 201);
  const operator = request.agent(
    controlApp({ ...s, directory: directory(['operator']), notifications: s.service }).app,
  );
  await operator
    .post('/api/login')
    .set('Origin', 'http://localhost:5173')
    .send({ username: 'test', password: 'valid-test-password' });
  assert.equal((await operator.get('/api/notifications')).status, 403);
});
