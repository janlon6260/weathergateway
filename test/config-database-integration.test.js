import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import mysql from 'mysql2/promise';
import { Store } from '../server/store.js';
import { configuration, initialize } from '../server/bootstrap.js';
import { observation } from './helpers.js';
import { ingest } from '../server/observations.js';
import { startBackup, finishBackups } from '../server/backups.js';
import Database from 'better-sqlite3';
test(
  'real MariaDB is authoritative for settings, changes, audit and secrets; weather remains separate and rollback/restart retain state',
  { skip: !process.env.WG_MARIADB_BIN, timeout: 90000 },
  async () => {
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
