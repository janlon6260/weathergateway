import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import mqtt from 'mqtt';
import { Store } from '../server/store.js';
import { configuration, initialize } from '../server/bootstrap.js';
import { CertificateIssuer, opensslExecutable } from '../server/pki.js';
import { startWorker } from '../server/worker.js';
import { observation } from './helpers.js';
import { mqttSubjectAltNames } from '../server/tls-identities.js';
import { logSession, readDeviceLogs } from '../server/device-logs.js';
import { deviceProfile } from '../shared/device-hardware.js';
import { deviceSchema } from '../server/schema.js';

const binary = process.env.WG_MOSQUITTO_BIN;
const deadline = (promise, ms = 8000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Integration timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
test(
  'real MQTT 5/mTLS broker isolates stations, validates IP SAN and requires a gateway receipt after durable storage',
  { skip: !binary, timeout: 40000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'wg-mqtt-integration-')),
      ca = join(root, 'ca.pem'),
      key = join(root, 'ca.key');
    const openssl = (args) => execFileSync(opensslExecutable, args, { stdio: 'ignore', windowsHide: true });
    openssl([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      key,
      '-out',
      ca,
      '-subj',
      '/CN=WG-Integration-Only',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    const leaf = (name, cn, extensions) => {
      const privateKey = join(root, `${name}.key`),
        csr = join(root, `${name}.csr`),
        pem = join(root, `${name}.pem`),
        ext = join(root, `${name}.cnf`);
      openssl([
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        privateKey,
        '-out',
        csr,
        '-subj',
        `/CN=${cn}`,
      ]);
      writeFileSync(
        ext,
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n${extensions}\n`,
      );
      openssl([
        'x509',
        '-req',
        '-in',
        csr,
        '-CA',
        ca,
        '-CAkey',
        key,
        '-set_serial',
        `0x${randomBytes(16).toString('hex')}`,
        '-days',
        '1',
        '-sha256',
        '-extfile',
        ext,
        '-out',
        pem,
      ]);
      return { certificate: readFileSync(pem), privateKey: readFileSync(privateKey), pem, key: privateKey };
    };
    const serverLeaf = leaf(
        'server',
        '127.0.0.1',
        `extendedKeyUsage=serverAuth\nsubjectAltName=${mqttSubjectAltNames('127.0.0.1')}`,
      ),
      workerLeaf = leaf('worker', 'gateway-worker', 'extendedKeyUsage=clientAuth');
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const config = configuration({
      WG_ENVIRONMENT: 'development',
      WG_ALLOW_LOCAL_HTTP: 'true',
      WG_ADMIN_ORIGIN: 'http://localhost:5173',
      WG_PUBLIC_ORIGIN: 'https://127.0.0.1',
      WG_MQTT_URL: `mqtts://127.0.0.1:${port}`,
      WG_MQTT_CA_FILE: ca,
      WG_MQTT_CERT_FILE: workerLeaf.pem,
      WG_MQTT_KEY_FILE: workerLeaf.key,
    });
    const store = new Store({ root: join(root, 'data'), environment: 'development' });
    initialize(store, config.defaults);
    const stations = store.stationList(),
      issuer = new CertificateIssuer({ store, keyFile: key, caFile: ca }),
      first = await issuer.issue(stations[0].value.id),
      second = await issuer.issue(stations[1].value.id);
    const configPath = join(root, 'mosquitto.conf');
    writeFileSync(
      configPath,
      `listener ${port} 127.0.0.1\nallow_anonymous false\nrequire_certificate true\nuse_identity_as_username true\nuse_username_as_clientid true\ncafile ${ca.replaceAll('\\', '/')}\ncertfile ${serverLeaf.pem.replaceAll('\\', '/')}\nkeyfile ${serverLeaf.key.replaceAll('\\', '/')}\nacl_file ${store.safe('system', 'mqtt', 'acl').replaceAll('\\', '/')}\npersistence false\nlog_dest stdout\n`,
    );
    const broker = spawn(resolve(binary), ['-c', configPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    broker.stdout.on('data', (b) => {
      logs = (logs + b).slice(-16000);
    });
    broker.stderr.on('data', (b) => {
      logs = (logs + b).slice(-16000);
    });
    const clients = [];
    let stopWorker;
    const client = async (bundle) => {
      const c = mqtt.connect(config.mqttUrl, {
        protocolVersion: 5,
        reconnectPeriod: 0,
        connectTimeout: 3000,
        ca: readFileSync(ca),
        cert: bundle?.certificate,
        key: bundle?.privateKey,
        rejectUnauthorized: true,
      });
      clients.push(c);
      c.on('error', () => {});
      await deadline(
        Promise.race([
          once(c, 'connect'),
          once(c, 'error').then(([e]) => {
            throw e;
          }),
        ]),
      );
      return c;
    };
    const waitMessage = (c, topic) =>
      deadline(
        new Promise((resolve) => {
          const handler = (t, b) => {
            if (t === topic) {
              c.off('message', handler);
              resolve(JSON.parse(b.toString()));
            }
          };
          c.on('message', handler);
        }),
      );
    try {
      // Native Windows stdout is buffered on pipes: probe the actual listener.
      await deadline(
        (async () => {
          for (;;) {
            if (broker.exitCode !== null) throw new Error(`Broker exited: ${logs}`);
            const listening = await new Promise((resolve) => {
              const socket = createConnection({ host: '127.0.0.1', port });
              socket.once('connect', () => {
                socket.destroy();
                resolve(true);
              });
              socket.once('error', () => resolve(false));
            });
            if (listening) return;
            await new Promise((r) => setTimeout(r, 100));
          }
        })(),
      );
      await assert.rejects(client(null));
      const a = await client(first),
        b = await client(second),
        topic = `wg/v1/development/stations/${first.stationId}`;
      await a.subscribeAsync(`${topic}/telemetry-receipt`, { qos: 1 });
      await b.subscribeAsync(`${topic}/telemetry-receipt`, { qos: 1 }).catch(() => {});
      let foreignReceipts = 0;
      b.on('message', (t) => {
        if (t === `${topic}/telemetry-receipt`) foreignReceipts++;
      });
      const body = observation(first.stationId, Date.now());
      // Broker PUBACK succeeds with no subscriber; no observation is stored yet.
      await a.publishAsync(`${topic}/telemetry`, JSON.stringify(body), { qos: 1 });
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 0);
      stopWorker = startWorker(store, config);
      // Wait for the worker MQTT subscription using a successful application receipt.
      let receiptPromise = waitMessage(a, `${topic}/telemetry-receipt`);
      const retry = setInterval(() => a.publish(`${topic}/telemetry`, JSON.stringify(body), { qos: 1 }), 200);
      try {
        const receipt = await receiptPromise;
        assert.equal(receipt.status, 'stored');
      } finally {
        clearInterval(retry);
      }
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
      assert.equal(foreignReceipts, 0);
      const lease = logSession(store, first.stationId, { seconds: 120 }, 'integration-test');
      const line = {
        version: 1,
        stationId: first.stationId,
        sessionId: lease.sessionId,
        bootId: body.bootId,
        sequence: 1,
        uptimeMs: 1000,
        level: 'info',
        message: 'MQTT log integration',
        dropped: 0,
      };
      const publishLine = (sender, sequence, override = {}) =>
        sender
          .publishAsync(`${topic}/logs`, JSON.stringify({ ...line, sequence, ...override }), { qos: 1 })
          .catch(() => {});
      const waitLog = (sequence) =>
        deadline(
          (async () => {
            while (!readDeviceLogs(store, first.stationId, 0).entries.some((r) => r.sequence === sequence))
              await new Promise((r) => setTimeout(r, 50));
          })(),
        );
      await publishLine(a, 1);
      await waitLog(1);
      await publishLine(b, 2); // Another station's certificate must not write this topic.
      await publishLine(a, 3);
      await waitLog(3);
      await publishLine(a, 4, { stationId: second.stationId }); // Topic and payload identities must agree.
      await publishLine(a, 5);
      await waitLog(5);
      assert.deepEqual(
        readDeviceLogs(store, first.stationId, 0).entries.map((r) => r.sequence),
        [1, 3, 5],
      );
      assert.equal(readDeviceLogs(store, second.stationId, 0).entries.length, 0);
      const invalid = { ...body, stationId: second.stationId, sequence: 2 };
      await a
        .publishAsync(`wg/v1/development/stations/${second.stationId}/telemetry`, JSON.stringify(invalid), {
          qos: 1,
        })
        .catch(() => {});
      assert.equal(
        store.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE station_id=?').get(second.stationId).n,
        0,
      );
      // The native cabled protocol traverses the same authenticated, durable
      // path as radio. No RSSI or invented radio CRC is attached to its bytes.
      assert.equal(store.confirmedValue(`station:${second.stationId}`).model, 'Davis Vantage Pro2');
      const wired = deviceSchema.parse(
        deviceProfile(store.confirmedValue(`device:${second.stationId}`), 'davis-iss-rs485'),
      );
      store.db
        .prepare('UPDATE configuration SET payload=? WHERE scope=?')
        .run(JSON.stringify(wired), `device:${second.stationId}`);
      const wiredTopic = `wg/v1/development/stations/${second.stationId}`;
      await b.subscribeAsync(`${wiredTopic}/telemetry-receipt`, { qos: 1 });
      const native = observation(second.stationId, Date.now(), {
        measurements: {},
        source: {
          protocol: 'davis-iss-rs485',
          packet: Buffer.from('8004700f9900', 'hex').toString('base64'),
        },
      });
      const stored = waitMessage(b, `${wiredTopic}/telemetry-receipt`);
      await b.publishAsync(`${wiredTopic}/telemetry`, JSON.stringify(native), { qos: 1 });
      assert.equal((await stored).status, 'stored');
      const saved = JSON.parse(
        store.db.prepare('SELECT body FROM observations WHERE station_id=?').get(second.stationId).body,
      );
      assert.equal(saved.quality.linkChecksum, 'none');
      assert.equal(saved.measurements.temperatureC, (3993 / 160 - 32) / 1.8);
      const rejected = waitMessage(b, `${wiredTopic}/telemetry-receipt`);
      await b.publishAsync(
        `${wiredTopic}/telemetry`,
        JSON.stringify({
          ...native,
          sequence: 2,
          source: { protocol: 'davis-iss-rs485', packet: Buffer.alloc(6).toString('base64') },
        }),
        { qos: 1 },
      );
      assert.equal((await rejected).status, 'rejected');
      assert.equal(
        store.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE station_id=?').get(second.stationId).n,
        1,
      );
    } catch (error) {
      error.message += `\nBroker diagnostic: ${logs}`;
      throw error;
    } finally {
      for (const c of clients) c.end(true);
      if (stopWorker) await stopWorker();
      const exited = once(broker, 'exit');
      broker.kill();
      await deadline(exited).catch(() => {});
      store.close();
      const rel = relative(resolve(tmpdir()), root);
      if (!rel.startsWith('..') && rel.startsWith('wg-mqtt-integration-'))
        rmSync(root, { recursive: true, force: true });
    }
  },
);
