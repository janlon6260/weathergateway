import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import mysql from 'mysql2/promise';
import { Store } from '../server/store.js';
import { configuration, initialize } from '../server/bootstrap.js';
import { observation, directory } from './helpers.js';
import { ingest } from '../server/observations.js';
import { startBackup, finishBackups } from '../server/backups.js';
import Database from 'better-sqlite3';
import { ApiClients } from '../server/api-clients.js';
import request from 'supertest';
import { CertificateManager } from '../server/certificates.js';
import { CertificateIssuer } from '../server/pki.js';
import { FirmwareBuilds } from '../server/firmware-builds.js';
import { controlApp } from '../server/app.js';
test(
  'real MariaDB is authoritative for settings, changes, audit and secrets; weather remains separate and rollback/restart retain state',
  { skip: !process.env.WG_MARIADB_BIN, timeout: 90000 },
  async (t) => {
    const base = resolve('artifacts');
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, 'config-mariadb-')),
      binary = resolve(process.env.WG_MARIADB_BIN),
      data = join(root, 'data');
    execFileSync(join(dirname(binary), 'mariadb-install-db.exe'), [`--datadir=${data}`, '--silent'], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 30000,
    });
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const server = spawn(
      binary,
      [
        '--no-defaults',
        '--console',
        `--datadir=${data}`,
        `--port=${port}`,
        '--bind-address=127.0.0.1',
        '--skip-ssl',
        '--skip-log-bin',
        '--innodb-buffer-pool-size=32M',
        '--innodb-log-file-size=16M',
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    let admin, store;
    try {
      for (let i = 0; i < 100 && !admin; i++)
        try {
          admin = await mysql.createConnection({
            host: '127.0.0.1',
            port,
            user: 'root',
            connectTimeout: 500,
          });
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      assert.ok(admin, 'Temporary MariaDB started');
      const options = { host: '127.0.0.1', port, user: 'root', database: 'weathergateway_test' },
        cfg = configuration({ WG_ENVIRONMENT: 'development', WG_ALLOW_LOCAL_HTTP: 'true' });
      let now = Date.now();
      const tlsConfig = configuration({
        WG_CONFIG_DB_HOST: 'db.example.invalid',
        WG_CONFIG_DB_TLS: 'true',
      }).configurationDatabase;
      assert.equal(tlsConfig.ssl.verifyIdentity, true);
      assert.equal(tlsConfig.ssl.rejectUnauthorized, true);
      assert.equal(tlsConfig.ssl.minVersion, 'TLSv1.2');
      // Seed the previous local format, then prove migration and SQL authority.
      store = new Store({ root: join(root, 'gateway'), environment: 'development', clock: () => now });
      initialize(store, cfg.defaults);
      const id = store.stationList()[0].value.id;
      store.close();
      store = null;
      store = new Store({
        root: join(root, 'gateway'),
        environment: 'development',
        clock: () => now,
        configurationDatabase: options,
      });
      initialize(store, cfg.defaults);
      assert.equal(store.db.backend, 'mariadb');
      await t.test(
        'HTTP freshness trials and device command trials work against MariaDB and roll back atomically',
        async () => {
          const agent = request.agent(controlApp({ store, config: cfg, directory: directory() }).app);
          const logged = await agent
            .post('/api/login')
            .set('Origin', cfg.defaults.adminOrigin)
            .send({ username: 'test', password: 'valid-test-password' })
            .expect(200);
          const post = (path, body = {}) =>
            agent
              .post(path)
              .set('Origin', cfg.defaults.adminOrigin)
              .set('X-CSRF-Token', logged.body.csrf)
              .send(body);
          for (const scope of [`station:${id}`, 'gateway', `device:${id}`]) {
            const current = store.current(scope);
            const value =
              scope === 'gateway'
                ? { ...current.value, dataWarningSeconds: 10 }
                : scope.startsWith('station:')
                  ? { ...current.value, freshness: { warningSeconds: 10, downSeconds: 30 } }
                  : { ...current.value, sampleSeconds: 3 };
            const drafted = await post('/api/changes', { scope, revision: current.revision, value }).expect(
              201,
            );
            const tested = await post(`/api/changes/${drafted.body.id}/test`).expect(200);
            assert.equal(tested.body.state, 'testing');
            await post(`/api/changes/${drafted.body.id}/cancel`).expect(200);
            assert.deepEqual(store.confirmedValue(scope), current.value);
          }
          const commands = store.db.prepare('SELECT sequence,kind FROM commands ORDER BY sequence').all();
          assert.deepEqual(
            commands.map((c) => c.kind),
            ['test_config', 'rollback_config'],
          );
          assert.ok(commands[1].sequence > commands[0].sequence);
          // Testing a station also sweeps expired device trials. Previously this
          // rollback could surface the device SQL parse error on a threshold edit.
          const device = store.current(`device:${id}`);
          const trial = store.propose(
            device.scope,
            { ...device.value, sampleSeconds: 4 },
            device.revision,
            'test',
          );
          store.begin(trial.id, 'test');
          const station = store.current(`station:${id}`);
          const draft = await post('/api/changes', {
            scope: station.scope,
            revision: station.revision,
            value: { ...station.value, freshness: { warningSeconds: 12, downSeconds: 40 } },
          }).expect(201);
          now += store.timeoutSeconds() * 1000 + 1;
          await post(`/api/changes/${draft.body.id}/test`).expect(200);
          assert.equal(store.getChange(trial.id).state, 'rolled_back');
          assert.deepEqual(store.confirmedValue(device.scope), device.value);
          await post(`/api/changes/${draft.body.id}/confirm`).expect(200);
          assert.equal(store.confirmedValue(station.scope).freshness.warningSeconds, 12);
        },
      );
      await t.test(
        'firmware HTTP request queues and updates a build against the existing MariaDB schema without a log default',
        async () => {
          const buildConfig = configuration({
            WG_ENVIRONMENT: 'development',
            WG_ALLOW_LOCAL_HTTP: 'true',
            WG_DATA_ROOT: store.root,
            WG_CERTIFICATE_ROOT: join(root, 'certificates'),
          });
          const manager = new CertificateManager({ store, config: buildConfig });
          await manager.initialize(
            {
              caValidity: { amount: 2, unit: 'years' },
              validity: { amount: 1, unit: 'years' },
              names: ['gateway.invalid'],
            },
            'test',
          );
          const certificates = new CertificateIssuer({
            store,
            keyFile: buildConfig.issuerKeyFile,
            caFile: buildConfig.issuerCaFile,
          });
          const builds = new FirmwareBuilds({
            store,
            config: buildConfig,
            certificates,
            certificateManager: manager,
          });
          writeFileSync(
            join(builds.root, 'worker.json'),
            JSON.stringify({ at: Date.now(), environment: store.environment }),
          );
          // Reproduce already-created production schemas; no migration may be
          // required for the corrected application insert to work.
          await admin.query(
            'ALTER TABLE weathergateway_test.firmware_builds MODIFY COLUMN log LONGTEXT NOT NULL',
          );
          const agent = request.agent(
            controlApp({ store, config: buildConfig, directory: directory(), firmwareBuilds: builds }).app,
          );
          const login = await agent
            .post('/api/login')
            .set('Origin', cfg.defaults.adminOrigin)
            .send({ username: 'test', password: 'valid-test-password' })
            .expect(200);
          const queued = await agent
            .post(`/api/firmware-builds/stations/${id}`)
            .set('Origin', cfg.defaults.adminOrigin)
            .set('X-CSRF-Token', login.body.csrf)
            .send({
              mqttHost: 'gateway.invalid',
              mqttPort: 8883,
              ssid: 'SQL-regression',
              wifiPassword: 'local-regression-only',
              purpose: 'usb',
            })
            .expect(202);
          const buildId = queued.body.id;
          assert.equal(queued.body.state, 'queued');
          assert.equal(builds.row(buildId).log, '');
          assert.equal(store.db.local.prepare('SELECT COUNT(*) AS n FROM firmware_builds').get().n, 0);
          assert.equal(existsSync(join(builds.root, buildId, 'request.json')), true);
          writeFileSync(
            join(builds.root, buildId, 'progress.json'),
            JSON.stringify({ log: 'Compiler started' }),
          );
          builds.poll();
          assert.equal(builds.row(buildId).state, 'building');
          assert.equal(builds.row(buildId).log, 'Compiler started');
          builds.cancel(buildId, 'test');
          assert.equal(builds.row(buildId).state, 'failed');
          assert.equal(existsSync(join(builds.root, buildId, 'request.json')), false);
        },
      );
      const apiClients = new ApiClients(store, {
        ...cfg,
        publicAccessFile: join(root, 'policies', 'socket-clients.json'),
      });
      const approval = apiClients.create(
        { name: 'SQL persisted approval', allStations: false, stationIds: [id] },
        'admin',
      );
      assert.equal(store.db.local.prepare('SELECT COUNT(*) AS n FROM api_clients').get().n, 0);
      assert.ok(!JSON.stringify(apiClients.list()).includes(approval.token));
      assert.equal(store.db.local.prepare('SELECT COUNT(*) AS n FROM configuration').get().n, 0);
      const current = store.current(`station:${id}`),
        draft = store.propose(
          current.scope,
          { ...current.value, name: 'SQL station' },
          current.revision,
          'test',
        );
      store.begin(draft.id, 'test');
      store.health(draft.id, true, { ok: true });
      store.confirm(draft.id, 'test');
      assert.equal(store.confirmedValue(current.scope).name, 'SQL station');
      store.db.prepare('INSERT INTO settings_secrets VALUES (?,?)').run('test', 'encrypted-ciphertext');
      ingest(store, id, observation(id, new Date(now).toISOString()));
      assert.equal(store.db.local.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
      const [tables] = await admin.query('SHOW TABLES FROM weathergateway_test');
      assert.ok(tables.some((r) => Object.values(r)[0] === 'configuration'));
      assert.ok(!tables.some((r) => Object.values(r)[0] === 'wx_data'));
      const [rows] = await admin.query(
        'SELECT payload FROM weathergateway_test.configuration WHERE scope=?',
        [current.scope],
      );
      assert.equal(JSON.parse(rows[0].payload).name, 'SQL station');
      store.close();
      store = null;
      store = new Store({
        root: join(root, 'gateway'),
        environment: 'development',
        clock: () => now,
        configurationDatabase: options,
      });
      assert.equal(store.confirmedValue(current.scope).name, 'SQL station');
      assert.equal(
        store.db.prepare('SELECT payload FROM settings_secrets WHERE name=?').get('test').payload,
        'encrypted-ciphertext',
      );
      const again = store.current(current.scope),
        trial = store.propose(current.scope, { ...again.value, name: 'Timed out' }, again.revision, 'test');
      store.begin(trial.id, 'test');
      now += 300001;
      store.sweep();
      assert.equal(store.getChange(trial.id).state, 'rolled_back');
      assert.equal(store.confirmedValue(current.scope).name, 'SQL station');
      assert.ok(store.db.exportSettings().tables.configuration.length);
      const snapshot = store.db.exportSettings();
      const backup = startBackup(store, 'test');
      await finishBackups(store);
      assert.equal(backup.state, 'complete');
      const copied = new Database(store.safe('system', 'backups', `${backup.id}.sqlite3`), {
        readonly: true,
      });
      try {
        assert.equal(
          JSON.parse(
            copied.prepare('SELECT payload FROM configuration WHERE scope=?').get(current.scope).payload,
          ).name,
          'SQL station',
        );
        assert.ok(copied.prepare('SELECT payload FROM settings_secrets WHERE name=?').get('test'));
      } finally {
        copied.close();
      }
      store.db.prepare('DELETE FROM settings_secrets WHERE name=?').run('test');
      store.db.importSettings(snapshot);
      assert.equal(
        store.db.prepare('SELECT payload FROM settings_secrets WHERE name=?').get('test').payload,
        'encrypted-ciphertext',
      );
      assert.throws(
        () =>
          new Store({
            root: join(root, 'wrong'),
            environment: 'production',
            configurationDatabase: options,
          }),
        /annet miljø/,
      );
      const gatewayRoot = store.root;
      store.close();
      store = null;
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('WG_')));
      execFileSync(process.execPath, ['scripts/restore-backup.js', backup.id], {
        windowsHide: true,
        stdio: 'pipe',
        timeout: 30000,
        env: {
          ...env,
          WG_OFFLINE_RESTORE: 'services-stopped',
          WG_ENVIRONMENT: 'development',
          WG_DATA_ROOT: gatewayRoot,
          WG_CONFIG_DB_HOST: '127.0.0.1',
          WG_CONFIG_DB_PORT: String(port),
          WG_CONFIG_DB_USER: 'root',
          WG_CONFIG_DB_DATABASE: options.database,
        },
      });
      store = new Store({ root: gatewayRoot, environment: 'development', configurationDatabase: options });
      assert.equal(store.confirmedValue(current.scope).name, 'SQL station');
      assert.equal(
        store.db.prepare('SELECT payload FROM settings_secrets WHERE name=?').get('test').payload,
        'encrypted-ciphertext',
      );
      assert.ok(
        Number(store.db.prepare("SELECT value FROM meta WHERE key='command_sequence'").get().value) > 1e12,
      );
      assert.equal(
        JSON.parse(
          store.db.prepare('SELECT payload FROM api_clients WHERE id=?').get(approval.client.id).payload,
        ).name,
        'SQL persisted approval',
      );
      assert.equal(store.db.local.prepare('SELECT COUNT(*) AS n FROM configuration').get().n, 0);
    } catch (error) {
      console.error('CONFIG_DB_TEST', error.code, error.message);
      throw error;
    } finally {
      store?.close();
      await admin?.end();
      server.kill();
      await new Promise((r) => server.once('exit', r));
      const rel = relative(base, root);
      if (!rel.startsWith('..') && rel.startsWith('config-mariadb-'))
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
