import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import request from 'supertest';
import { setup, directory } from './helpers.js';
import { hash } from '../server/store.js';
import { controlApp, publicApp } from '../server/app.js';
import {
  ingestDeviceLog,
  logSession,
  pruneDeviceLogs,
  readDeviceLogs,
  cleanDeviceLog,
} from '../server/device-logs.js';
import { usbLayout, usbManifestText } from '../shared/usb-firmware.js';
import { verifyUsbFirmware } from '../server/usb-firmware.js';
import { DeviceSerial, prepareUsbBundle, appendTerminal } from '../web/src/device-serial.js';
import { syncAcl } from '../server/pki.js';
import { readFileSync } from 'node:fs';

function flashFixture(t) {
  const s = setup(t),
    stationId = s.store.stationList()[0].value.id,
    certificateId = randomUUID();
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicFile = join(s.store.root, 'firmware-public.pem');
  writeFileSync(publicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  s.config.firmwarePublicKeyFile = publicFile;
  s.store.db
    .prepare('INSERT INTO certificates VALUES (?,?,?,?,?,?,NULL)')
    .run(certificateId, stationId, `${stationId}.test`, '01', s.now() + 86400000, 'test-only');
  const images = usbLayout.map((p, i) => {
    const image = Buffer.alloc(1024, i);
    image[0] = 0xe9;
    return image;
  });
  const manifest = {
    format: 'wg-usb-flash-1',
    stationId,
    environment: 'test',
    certificateId,
    configurationHash: hash(s.store.confirmedValue(`device:${stationId}`)),
    version: '2.1.0',
    chip: 'esp32',
    flashSize: 4194304,
    securityProfile: 'standard',
    segments: usbLayout.map((p, i) => ({
      name: p.name,
      address: p.address,
      size: images[i].length,
      sha256: createHash('sha256').update(images[i]).digest('hex'),
    })),
  };
  const signature = sign('sha256', Buffer.from(usbManifestText(manifest)), {
    key: pair.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  return {
    ...s,
    stationId,
    certificateId,
    pair,
    images,
    input: { manifest, signature, images: images.map((i) => i.toString('base64')) },
  };
}

test('USB package verifies every image in the browser and trusted station/environment/certificate/signature on the gateway', async (t) => {
  const s = flashFixture(t),
    { manifest, signature } = s.input;
  const prepared = await prepareUsbBundle(s.input, s.stationId, 'test');
  assert.equal(prepared.segments.length, 4);
  assert.equal(
    verifyUsbFirmware(s.store, s.config, s.stationId, { manifest, signature }, 'admin').verified,
    true,
  );
  assert.throws(
    () =>
      verifyUsbFirmware(
        s.store,
        s.config,
        s.stationId,
        { manifest: { ...manifest, version: '3.0' }, signature },
        'admin',
      ),
    /signatur/,
  );
  await assert.rejects(
    prepareUsbBundle(
      { ...s.input, images: s.input.images.map((v, i) => (i ? v : Buffer.alloc(1024).toString('base64'))) },
      s.stationId,
      'test',
    ),
    /Kontrollsummen/,
  );
  await assert.rejects(prepareUsbBundle(s.input, s.stationId, 'production'), /miljø/);
  await assert.rejects(
    prepareUsbBundle(
      {
        ...s.input,
        manifest: { ...manifest, segments: manifest.segments.map((v, i) => (i ? v : { ...v, address: 0 })) },
      },
      s.stationId,
      'test',
    ),
    /flashsegment/,
  );
  s.store.db.prepare('UPDATE certificates SET revoked_at=? WHERE id=?').run(s.now(), s.certificateId);
  assert.throws(
    () => verifyUsbFirmware(s.store, s.config, s.stationId, { manifest, signature }, 'admin'),
    /sertifikatet/,
  );
});

test('USB flasher checks eFuses before a RAM stub, verifies flash readback and always releases the serial port', async (t) => {
  const s = flashFixture(t),
    bundle = await prepareUsbBundle(s.input, s.stationId, 'test');
  const events = [],
    memory = new Map();
  let corrupted = false,
    secured = false;
  class Transport {
    async disconnect() {
      events.push('disconnect');
    }
  }
  class Loader {
    chip = { CHIP_NAME: 'ESP32' };
    romBaudrate = 115200;
    async detectChip() {
      events.push('detect');
    }
    async readReg(address) {
      events.push('efuse');
      return secured && address === 0x3ff5a018 ? 0x20 : 0;
    }
    async runStub() {
      events.push('stub');
      this.IS_STUB = true;
    }
    async changeBaud() {}
    async detectFlashSize() {
      return '4MB';
    }
    async writeFlash(options) {
      assert.equal(options.eraseAll, true);
      assert.equal(options.flashMode, 'keep');
      events.push('write');
      options.fileArray.forEach((p) => memory.set(p.address, p.data));
    }
    async readFlash(address) {
      return corrupted ? new Uint8Array(1024) : memory.get(address);
    }
    async after() {
      events.push('reset');
    }
  }
  const controller = new DeviceSerial({
    serial: {
      async requestPort() {
        return {};
      },
    },
    loadFlasher: async () => ({ Transport, ESPLoader: Loader }),
  });
  const authorize = async () => events.push('authorize');
  await controller.flash(bundle, { authorize });
  assert.ok(events.indexOf('efuse') < events.indexOf('stub'));
  assert.ok(events.indexOf('authorize') < events.indexOf('write'));
  assert.deepEqual(events.slice(-2), ['reset', 'disconnect']);
  assert.equal(controller.mode, 'disconnected');
  events.length = 0;
  corrupted = true;
  await assert.rejects(controller.flash(bundle, { authorize }), /Verifisering/);
  assert.equal(events.includes('reset'), false);
  assert.equal(events.at(-1), 'disconnect');
  events.length = 0;
  secured = true;
  await assert.rejects(controller.flash(bundle, { authorize }), /maskinvaresikret/);
  assert.equal(events.includes('stub'), false);
  assert.equal(events.includes('write'), false);
  assert.equal(events.at(-1), 'disconnect');
});

test('USB packager uses actual ESP-IDF offsets, embedded identity and retained signing key; stale and secure builds are rejected', async (t) => {
  const s = flashFixture(t),
    build = join(s.store.root, 'usb-build'),
    project = join(s.store.root, 'usb-project');
  mkdirSync(join(build, 'config'), { recursive: true });
  mkdirSync(join(project, 'main'), { recursive: true });
  const jwk = s.pair.publicKey.export({ format: 'jwk' });
  const hex = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('hex');
  const defines = {
    WG_STATION_ID: s.stationId,
    WG_ENVIRONMENT: 'test',
    WG_CERTIFICATE_ID: s.certificateId,
    WG_DEFAULT_HASH: s.input.manifest.configurationHash,
    WG_OTA_PUBLIC_KEY_HEX: hex,
  };
  writeFileSync(
    join(project, 'main', 'provisioning.h'),
    Object.entries(defines)
      .map(([k, v]) => `#define ${k} ${JSON.stringify(v)}\n`)
      .join(''),
  );
  const app = Buffer.alloc(2048);
  app[0] = 0xe9;
  app.writeUInt32LE(0xabcd5432, 32);
  app.write('2.1.0', 48);
  app.write(Object.values(defines).join('\0'), 256);
  const flash_files = {};
  usbLayout.forEach((p, i) => {
    const name = `${p.name}.bin`;
    flash_files[`0x${p.address.toString(16)}`] = name;
    writeFileSync(join(build, name), i === 3 ? app : s.images[i]);
  });
  writeFileSync(
    join(build, 'flasher_args.json'),
    JSON.stringify({
      flash_files,
      app: { file: 'app.bin' },
      extra_esptool_args: { chip: 'esp32' },
      flash_settings: { flash_size: '4MB' },
    }),
  );
  writeFileSync(
    join(build, 'project_description.json'),
    JSON.stringify({ project_path: project, project_version: '2.1.0' }),
  );
  writeFileSync(join(build, 'config', 'sdkconfig.json'), JSON.stringify({ SECURE_BOOT: false }));
  const key = join(s.store.root, 'signing.key'),
    output = join(s.store.root, 'fixture.usb-flash.json');
  writeFileSync(key, s.pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const run = () =>
    execFileSync(process.execPath, ['scripts/package-usb-firmware.js', build, key, output], {
      stdio: 'pipe',
      windowsHide: true,
    });
  run();
  const input = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(
    (await prepareUsbBundle(input, s.stationId, 'test')).segments[3].data,
    new Uint8Array(app),
  );
  assert.equal(
    verifyUsbFirmware(
      s.store,
      s.config,
      s.stationId,
      { manifest: input.manifest, signature: input.signature },
      'admin',
    ).verified,
    true,
  );
  writeFileSync(join(build, 'config', 'sdkconfig.json'), JSON.stringify({ SECURE_BOOT: true }));
  assert.throws(run, /Maskinvaresikret/);
  writeFileSync(join(build, 'config', 'sdkconfig.json'), '{}');
  writeFileSync(
    key,
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }),
  );
  assert.throws(run, /Signeringsnøkkelen/);
  app.fill(0, 48, 80);
  app.write('old-version', 48);
  writeFileSync(join(build, 'app.bin'), app);
  assert.throws(run, /versjon/);
});

test('USB logger decodes split UTF-8, releases its read lock and cannot share a port with flashing', async () => {
  let released = false,
    closed = false,
    pending;
  const chunks = [Uint8Array.from([0x56, 0xc3]), Uint8Array.from([0xa6, 0x72, 10])];
  const reader = {
    async read() {
      if (chunks.length) return { value: chunks.shift(), done: false };
      return new Promise((r) => (pending = r));
    },
    async cancel() {
      pending({ done: true });
    },
    releaseLock() {
      released = true;
    },
  };
  const port = {
    async open() {},
    async setSignals() {},
    readable: { getReader: () => reader },
    async close() {
      closed = true;
    },
  };
  let output = '';
  const controller = new DeviceSerial({
    serial: {
      async requestPort() {
        return port;
      },
    },
    output: (s) => (output += s),
  });
  await controller.readLogs();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(controller.flash({}), /Koble fra/);
  await controller.disconnect();
  assert.equal(output, 'Vær\n');
  assert.ok(released && closed);
  assert.equal(controller.mode, 'disconnected');
  assert.ok(appendTerminal('', 'x\n'.repeat(2000)).split('\n').length <= 1000);
  assert.equal(appendTerminal('', '\x1b[31m<script>x</script>\x00'), '<script>x</script>');
});

test('MQTT logs require an active per-station lease, reject retained/spoofed packets and bound retention and cursor history', (t) => {
  const { store, tick, now } = setup(t),
    stationId = store.stationList()[0].value.id;
  const lease = logSession(store, stationId, { seconds: 120 }, 'operator');
  const body = {
    version: 1,
    stationId,
    sessionId: lease.sessionId,
    bootId: randomUUID(),
    sequence: 1,
    uptimeMs: 1000,
    level: 'warn',
    message: '\x1b[31mW wifi password=do-not-store\x00',
    dropped: 0,
  };
  const send = (value, opts) => ingestDeviceLog(store, stationId, Buffer.from(JSON.stringify(value)), opts);
  assert.equal(send(body), true);
  assert.equal(send(body), false);
  const rows = readDeviceLogs(store, stationId, 0);
  assert.equal(rows.entries.length, 1);
  assert.equal(rows.entries[0].message.includes('do-not-store'), false);
  assert.equal(
    cleanDeviceLog('"password": "secret with spaces", token=private-token').includes('secret with spaces'),
    false,
  );
  assert.equal(
    cleanDeviceLog('Authorization: Bearer private-token-value').includes('private-token-value'),
    false,
  );
  assert.equal(
    cleanDeviceLog('-----BEGIN PRIVATE KEY-----\nbase64-key-body\n-----END PRIVATE KEY-----').includes(
      'base64-key-body',
    ),
    false,
  );
  assert.equal(readDeviceLogs(store, stationId, rows.cursor).entries.length, 0);
  assert.throws(() => send(body, { retained: true }), /loggmelding/);
  assert.throws(() => send({ ...body, stationId: store.stationList()[1].value.id }), /identitet/);
  assert.equal(send({ ...body, sessionId: randomUUID(), sequence: 2 }), false);
  for (let sequence = 2; sequence < 1008; sequence++) send({ ...body, sequence });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM device_logs').get().n, 1000);
  const replacement = logSession(store, stationId, { seconds: 120 }, 'operator');
  assert.notEqual(replacement.sessionId, lease.sessionId);
  assert.throws(
    () => logSession(store, stationId, { seconds: 0, sessionId: lease.sessionId }, 'operator'),
    /erstattet/,
  );
  assert.equal(send({ ...body, sequence: 1100 }), false);
  logSession(store, stationId, { seconds: 0, sessionId: replacement.sessionId }, 'operator');
  assert.equal(send({ ...body, sessionId: replacement.sessionId, sequence: 1100 }), false);
  tick(3600001);
  pruneDeviceLogs(store);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM device_logs').get().n, 0);
  assert.throws(() => readDeviceLogs(store, stationId, '-1'));
  syncAcl(store);
  const acl = readFileSync(store.safe('system', 'mqtt', 'acl'), 'utf8');
  assert.ok(acl.includes('topic read wg/v1/test/stations/+/logs'));
  assert.ok(!acl.includes('topic read wg/v1/test/stations/+/commands'));
});

test('device tooling endpoints enforce AD roles, CSRF and private admin-only exposure', async (t) => {
  const s = flashFixture(t),
    { manifest, signature } = s.input;
  for (const role of ['viewer', 'operator', 'administrator']) {
    const { app } = controlApp({ store: s.store, config: s.config, directory: directory([role]) });
    const agent = request.agent(app);
    const login = await agent
      .post('/api/login')
      .set('Origin', s.config.defaults.adminOrigin || 'http://localhost:5173')
      .send({ username: 'test', password: 'valid-test-password' })
      .expect(200);
    const logs = `/api/devices/${s.stationId}/logs`,
      flash = `/api/devices/${s.stationId}/flash/verify`;
    await agent.get(logs).expect(role === 'viewer' ? 403 : 200);
    await agent
      .post(`${logs}/session`)
      .set('Origin', 'http://localhost:5173')
      .send({ seconds: 120 })
      .expect(403);
    await agent
      .post(`${logs}/session`)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', login.body.csrf)
      .send({ seconds: 120 })
      .expect(role === 'viewer' ? 403 : 202);
    await agent
      .post(flash)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', login.body.csrf)
      .send({ manifest, signature })
      .expect(role === 'administrator' ? 200 : 403);
  }
  const token = 'device-tools-readonly-test-token';
  const { app } = publicApp({
    store: s.store,
    config: { ...s.config, publicToken: token, publicTokenFile: null },
  });
  await request(app).get(`/api/devices/${s.stationId}/logs`).expect(401);
  await request(app)
    .get(`/api/devices/${s.stationId}/logs`)
    .set('Authorization', `Bearer ${token}`)
    .expect(404);
});
