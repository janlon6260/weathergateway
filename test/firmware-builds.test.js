import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { setup, directory, observation } from './helpers.js';
import { CertificateManager } from '../server/certificates.js';
import { CertificateIssuer } from '../server/pki.js';
import { FirmwareBuilds } from '../server/firmware-builds.js';
import { hash } from '../server/store.js';
import { X509Certificate } from 'node:crypto';
import { verifyUsbFirmware } from '../server/usb-firmware.js';
import { prepareUsbBundle } from '../web/src/device-serial.js';
import { proposeFirmware } from '../server/firmware-updates.js';
import { handleAck, firmwareHealth } from '../server/worker.js';
import { ingest } from '../server/observations.js';
import { controlApp } from '../server/app.js';
import { deviceProfile } from '../shared/device-hardware.js';
import { readiness } from '../server/readiness.js';

async function fixture(t) {
  const s = setup(t),
    root = join(s.store.root, 'certificates');
  Object.assign(s.config, {
    root: s.store.root,
    certificateRoot: root,
    issuerKeyFile: join(root, 'client-ca.key'),
    issuerCaFile: join(root, 'client-ca.pem'),
    firmwarePublicKeyFile: join(root, 'firmware-signing-public.pem'),
  });
  const manager = new CertificateManager({ store: s.store, config: s.config });
  await manager.initialize(
    {
      caValidity: { amount: 50, unit: 'years' },
      validity: { amount: 1, unit: 'years' },
      names: ['wg-api.skrg.no', '172.30.30.100'],
    },
    'admin',
  );
  const certificates = new CertificateIssuer({
    store: s.store,
    keyFile: s.config.issuerKeyFile,
    caFile: s.config.issuerCaFile,
  });
  const builds = new FirmwareBuilds({
    store: s.store,
    config: s.config,
    certificates,
    certificateManager: manager,
  });
  writeFileSync(
    join(builds.root, 'worker.json'),
    JSON.stringify({ at: Date.now(), environment: s.store.environment }),
  );
  return { ...s, builds, certificates, manager, stationId: s.store.stationList()[0].value.id };
}
const input = {
  mqttHost: '172.30.30.100',
  mqttPort: 8883,
  ssid: 'TEST-NETWORK',
  wifiPassword: 'test-only-password-$"\\',
  purpose: 'usb',
};
test('OTA selects the connected identity after a separate certificate is issued and preserves both keys; public-only imports are refused', async (t) => {
  const s = await fixture(t),
    original = await s.certificates.issue(s.stationId);
  s.builds.remember(original);
  ingest(s.store, s.stationId, observation(s.stationId, s.now(), { certificateId: original.certificateId }));
  const replacement = await s.certificates.issue(s.stationId);
  s.builds.remember(replacement);
  const publicKey = new X509Certificate(original.certificate).publicKey.export({
    type: 'spki',
    format: 'pem',
  });
  assert.throws(
    () =>
      s.builds.importIdentity(
        s.stationId,
        { ...original, environment: 'test', privateKey: publicKey },
        'admin',
      ),
    /privatnøkkel/,
  );
  const build = await s.builds.start(s.stationId, { ...input, purpose: 'ota' }, 'admin');
  const saved = s.builds.identity(s.stationId);
  assert.equal(saved.privateKey, original.privateKey);
  assert.equal(
    saved.previousIdentities.some((p) => p.privateKey === replacement.privateKey),
    true,
  );
  s.builds.cancel(build.id, 'admin');
  assert.equal(s.builds.row(build.id).state, 'failed');
  assert.equal(existsSync(join(s.builds.root, build.id, 'request.json')), false);
});
function result(s, build) {
  const row = s.builds.row(build.id),
    p = JSON.parse(row.payload);
  const images = [Buffer.alloc(1024), Buffer.alloc(1024), Buffer.alloc(1024), Buffer.alloc(3072)];
  images[0][0] = images[3][0] = 0xe9;
  images[3].writeUInt32LE(0xabcd5432, 32);
  images[3].write('2.2.0', 48);
  images[3].write(
    [s.stationId, s.store.environment, p.certificateId, hash(p.configuration), p.otaHex, build.id].join('|'),
    128,
  );
  writeFileSync(
    join(s.builds.root, build.id, 'result.json'),
    JSON.stringify({
      buildId: build.id,
      environment: s.store.environment,
      images: images.map((v) => v.toString('base64')),
    }),
  );
  s.builds.poll();
  return s.builds.row(build.id);
}

test('MAX3485 ISS builds bind selected GPIOs and station to signed USB and OTA and reject unsupported Vue', async (t) => {
  const s = await fixture(t);
  const vueProfile = deviceProfile(s.store.confirmedValue(`device:${s.stationId}`), 'davis-iss-rs485');
  await assert.rejects(
    s.builds.start(s.stationId, { ...input, configuration: vueProfile }, 'admin'),
    /Vantage Pro2/,
  );
  s.stationId = s.store.stationList().find((r) => r.value.model === 'Davis Vantage Pro2').value.id;
  const configuration = {
    ...deviceProfile(s.store.confirmedValue(`device:${s.stationId}`), 'davis-iss-rs485'),
    uartBaud: '4800',
    uartRx: 17,
  };
  await assert.rejects(
    s.builds.start(
      s.stationId,
      { ...input, configuration: { ...configuration, stationId: vueProfile.stationId } },
      'admin',
    ),
    /annen stasjon/,
  );
  const build = await s.builds.start(s.stationId, { ...input, configuration }, 'admin');
  const staged = JSON.parse(readFileSync(join(s.builds.root, build.id, 'request.json'), 'utf8'));
  assert.ok(staged.files['provisioning.h'].includes('davis-iss-rs485'));
  assert.equal(result(s, build).state, 'ready');
  const bundle = s.builds.usb(build.id);
  await prepareUsbBundle(bundle, s.stationId, s.store.environment);
  s.builds.usbComplete(build.id, 'admin');
  const saved = s.store.confirmedValue(`device:${s.stationId}`);
  assert.equal(saved.uartBaud, '4800');
  assert.equal(saved.uartRx, 17);
  assert.equal(saved.mqttHost, input.mqttHost);
  assert.equal(
    readiness(s.store, s.config).checks.find((c) => c.id === `interface:${s.stationId}`).passed,
    true,
  );
  const ota = await s.builds.start(s.stationId, { ...input, configuration, purpose: 'ota' }, 'admin');
  assert.equal(result(s, ota).state, 'ready');
  const proposal = proposeFirmware(s.store, s.builds.row(ota.id).release_id, 'admin');
  assert.equal(proposal.scope, `firmware:${s.stationId}`);
});
test('OTA can change radio to native RS485 only during the signed firmware trial and commits the interface after matching weather and ACK', async (t) => {
  const s = await fixture(t);
  s.stationId = s.store.stationList().find((r) => r.value.model === 'Davis Vantage Pro2').value.id;
  const initial = await s.builds.start(s.stationId, input, 'admin');
  result(s, initial);
  s.builds.usbComplete(initial.id, 'admin');
  const before = s.store.confirmedValue(`device:${s.stationId}`),
    configuration = deviceProfile(before, 'davis-iss-rs485');
  const build = await s.builds.start(s.stationId, { ...input, configuration, purpose: 'ota' }, 'admin'),
    ready = result(s, build),
    candidate = JSON.parse(ready.payload).configuration;
  const receive = (sequence, extra = {}) =>
    ingest(
      s.store,
      s.stationId,
      observation(s.stationId, s.now(), {
        sequence,
        measurements: {},
        firmwareReleaseId: ready.release_id,
        configurationHash: hash(candidate),
        source: {
          protocol: 'davis-iss-rs485',
          packet: Buffer.from('8004700f9900', 'hex').toString('base64'),
        },
        ...extra,
      }),
    );
  assert.throws(() => receive(1));
  const trial = proposeFirmware(s.store, ready.release_id, 'admin');
  s.store.begin(trial.id, 'admin');
  const command = s.store.db
    .prepare("SELECT * FROM commands WHERE change_id=? AND kind='test_firmware'")
    .get(trial.id);
  handleAck(s.store, s.stationId, {
    version: 1,
    stationId: s.stationId,
    commandId: command.id,
    status: 'testing',
    firmwareReleaseId: ready.release_id,
    configurationHash: hash(candidate),
  });
  assert.throws(() => receive(2, { firmwareReleaseId: '402500fa-a03b-4dcf-af73-11109f9b8330' }));
  s.tick(1);
  receive(3);
  assert.equal(firmwareHealth(s.store, s.stationId), true);
  assert.deepEqual(s.store.confirmedValue(`device:${s.stationId}`), before);
  s.store.confirm(trial.id, 'admin');
  const commit = s.store.db
    .prepare("SELECT * FROM commands WHERE change_id=? AND kind='commit_firmware'")
    .get(trial.id);
  handleAck(s.store, s.stationId, {
    version: 1,
    stationId: s.stationId,
    commandId: commit.id,
    status: 'applied',
    firmwareReleaseId: ready.release_id,
    configurationHash: hash(candidate),
  });
  assert.deepEqual(s.store.confirmedValue(`device:${s.stationId}`), candidate);
  assert.equal(s.store.getChange(trial.id).state, 'confirmed');
});

test('server build retains encrypted identity, signs USB and OTA, keeps passwords out of database/status/audit and rejects stale artifacts', async (t) => {
  const s = await fixture(t),
    build = await s.builds.start(s.stationId, input, 'admin');
  const identity = s.builds.identity(s.stationId),
    staged = join(s.builds.root, build.id, 'request.json');
  assert.ok(existsSync(staged));
  assert.equal(
    s.store.db
      .prepare('SELECT payload FROM settings_secrets WHERE name=?')
      .get(`firmware:${s.stationId}`)
      .payload.includes(input.wifiPassword),
    false,
  );
  const header = JSON.parse(readFileSync(staged, 'utf8')).files['provisioning.h'];
  assert.ok(header.includes(JSON.stringify(input.wifiPassword)));
  assert.equal(result(s, build).state, 'ready');
  assert.equal(existsSync(staged), false);
  const usb = s.builds.usb(build.id);
  await prepareUsbBundle(usb, s.stationId, s.store.environment);
  verifyUsbFirmware(
    s.store,
    s.config,
    s.stationId,
    { manifest: usb.manifest, signature: usb.signature },
    'admin',
  );
  assert.equal(JSON.stringify(s.builds.status(s.stationId)).includes(input.wifiPassword), false);
  assert.equal(JSON.stringify(s.store.events()).includes(input.wifiPassword), false);
  assert.equal(
    readFileSync(s.store.safe('system', 'gateway.sqlite3')).includes(Buffer.from(input.wifiPassword)),
    false,
  );
  s.builds.usbComplete(build.id, 'admin');
  assert.equal(s.store.confirmedValue(`device:${s.stationId}`).mqttHost, input.mqttHost);
  const next = await s.builds.start(
    s.stationId,
    { ...input, wifiPassword: undefined, purpose: 'ota' },
    'admin',
  );
  assert.equal(s.builds.identity(s.stationId).privateKey, identity.privateKey);
  assert.equal(result(s, next).state, 'ready');
  const cfg = s.store.current(`device:${s.stationId}`);
  s.store.propose(cfg.scope, { ...cfg.value, mqttPort: 9000 }, cfg.revision, 'admin');
  const change = s.store.changes()[0];
  s.store.begin(change.id, 'admin');
  s.store.health(change.id, true, { deviceAck: true, deviceTelemetry: true });
  s.store.confirm(change.id, 'admin');
  // Snapshot comparison uses confirmed configuration; a testing candidate is never a build default.
  s.store.db.prepare("UPDATE changes SET state='confirmed' WHERE id=?").run(change.id);
  assert.throws(() => proposeFirmware(s.store, s.builds.row(next.id).release_id, 'admin'), /endret/);
});
test('OTA with compiled network settings needs matching telemetry and ACK; timeout preserves old settings, commit applies new settings atomically', async (t) => {
  const s = await fixture(t);
  s.builds.remember(await s.certificates.issue(s.stationId));
  const build = await s.builds.start(s.stationId, { ...input, purpose: 'ota' }, 'admin'),
    ready = result(s, build);
  const before = s.store.confirmedValue(`device:${s.stationId}`),
    candidate = JSON.parse(ready.payload).configuration;
  const draft = proposeFirmware(s.store, ready.release_id, 'admin');
  s.store.begin(draft.id, 'admin');
  assert.deepEqual(s.store.confirmedValue(`device:${s.stationId}`), before);
  const command = s.store.db.prepare("SELECT * FROM commands WHERE kind='test_firmware'").get();
  handleAck(s.store, s.stationId, {
    version: 1,
    stationId: s.stationId,
    commandId: command.id,
    status: 'testing',
    firmwareReleaseId: ready.release_id,
    configurationHash: hash(candidate),
  });
  ingest(
    s.store,
    s.stationId,
    observation(s.stationId, s.now(), {
      firmwareReleaseId: ready.release_id,
      configurationHash: hash(before),
    }),
  );
  assert.equal(firmwareHealth(s.store, s.stationId), false);
  s.tick(1);
  ingest(
    s.store,
    s.stationId,
    observation(s.stationId, s.now(), {
      sequence: 2,
      firmwareReleaseId: ready.release_id,
      configurationHash: hash(candidate),
    }),
  );
  assert.equal(firmwareHealth(s.store, s.stationId), true);
  s.store.confirm(draft.id, 'admin');
  const commit = s.store.db.prepare("SELECT * FROM commands WHERE kind='commit_firmware'").get();
  assert.throws(
    () =>
      handleAck(s.store, s.stationId, {
        version: 1,
        stationId: s.stationId,
        commandId: commit.id,
        status: 'applied',
        firmwareReleaseId: ready.release_id,
        configurationHash: hash(before),
      }),
    /andre/,
  );
  handleAck(s.store, s.stationId, {
    version: 1,
    stationId: s.stationId,
    commandId: commit.id,
    status: 'applied',
    firmwareReleaseId: ready.release_id,
    configurationHash: hash(candidate),
  });
  assert.equal(s.store.getChange(draft.id).state, 'confirmed');
  assert.deepEqual(s.store.confirmedValue(`device:${s.stationId}`), candidate);
  const next = await s.builds.start(
      s.stationId,
      { ...input, mqttHost: 'wg-api.skrg.no', purpose: 'ota' },
      'admin',
    ),
    r = result(s, next);
  const trial = proposeFirmware(s.store, r.release_id, 'admin');
  s.store.begin(trial.id, 'admin');
  s.tick(300001);
  s.store.sweep();
  assert.equal(s.store.getChange(trial.id).state, 'rolled_back');
  assert.deepEqual(s.store.confirmedValue(`device:${s.stationId}`), candidate);
});
test('build access requires administrator and CSRF; missing worker, invalid SAN, foreign identity, parallel builds and corrupt results are refused', async (t) => {
  const s = await fixture(t);
  const app = controlApp({ ...s, directory: directory(['reader']), firmwareBuilds: s.builds }).app;
  const agent = request.agent(app),
    login = await agent
      .post('/api/login')
      .set('Origin', 'http://localhost:5173')
      .send({ username: 'test', password: 'valid-test-password' });
  assert.equal((await agent.get(`/api/firmware-builds/stations/${s.stationId}`)).status, 403);
  assert.equal(
    (
      await agent
        .post(`/api/firmware-builds/stations/${s.stationId}`)
        .set('Origin', 'http://localhost:5173')
        .send(input)
    ).status,
    403,
  );
  await assert.rejects(
    s.builds.start(s.stationId, { ...input, mqttHost: 'evil.example' }, 'admin'),
    /serversertifikat/,
  );
  await assert.rejects(s.builds.start(s.stationId, { ...input, purpose: 'ota' }, 'admin'), /opprinnelige/);
  const build = await s.builds.start(s.stationId, input, 'admin');
  await assert.rejects(s.builds.start(s.stationId, input, 'admin'), /pågår/);
  const identity = s.builds.identity(s.stationId);
  assert.throws(
    () => s.builds.importIdentity(s.stationId, { ...identity, environment: 'production' }, 'admin'),
    /annet/,
  );
  assert.throws(
    () =>
      s.builds.importIdentity(
        s.stationId,
        { ...identity, environment: 'test', privateKey: readFileSync(s.config.issuerKeyFile, 'utf8') },
        'admin',
      ),
    /passer ikke/,
  );
  writeFileSync(
    join(s.builds.root, build.id, 'result.json'),
    JSON.stringify({ buildId: build.id, environment: 'production', images: [] }),
  );
  s.builds.poll();
  assert.equal(s.builds.row(build.id).state, 'failed');
  assert.equal(existsSync(join(s.builds.root, build.id, 'request.json')), false);
  s.tick(1);
  const timed = await s.builds.start(s.stationId, input, 'admin');
  s.tick(1800001);
  s.builds.poll();
  assert.equal(s.builds.row(timed.id).state, 'failed');
  writeFileSync(join(s.builds.root, 'worker.json'), JSON.stringify({ at: 0, environment: 'test' }));
  await assert.rejects(s.builds.start(s.stationId, input, 'admin'), /kjører ikke/);
});
