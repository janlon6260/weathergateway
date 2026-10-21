import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { Store } from '../server/store.js';
import { configuration, initialize } from '../server/bootstrap.js';
import { databaseSchema } from '../server/schema.js';
import { WeatherDatabase } from '../server/weather-database.js';
import { databaseStatus } from '../server/database-queue.js';
import {
  databaseColumns,
  extendedDatabaseColumns,
  vatneDatabaseColumns,
} from '../shared/database-columns.js';
import { ingest } from '../server/observations.js';
import { observation } from './helpers.js';

test(
  'real MariaDB: original Weather Display schemas remain unchanged, full weather mapping and uncertain-commit retry',
  { skip: !process.env.WG_MARIADB_BIN, timeout: 90000 },
  async () => {
    mkdirSync('artifacts', { recursive: true });
    const workspace = resolve('artifacts'),
      root = mkdtempSync(join(workspace, 'mariadb-integration-')),
      binary = resolve(process.env.WG_MARIADB_BIN);
    const data = join(root, 'sql-data');
    // No service is installed. The temporary server only binds an ephemeral loopback port.
    execFileSync(join(dirname(binary), 'mariadb-install-db.exe'), [`--datadir=${data}`, '--silent'], {
      stdio: 'pipe',
      windowsHide: true,
      timeout: 30000,
    });
    const probe = createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    assert.notEqual(port, 3306);
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
        '--sql-mode=STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let diagnostic = '';
    server.stdout.on('data', (b) => {
      diagnostic = (diagnostic + b).slice(-16000);
    });
    server.stderr.on('data', (b) => {
      diagnostic = (diagnostic + b).slice(-16000);
    });
    let admin, store, writer;
    try {
      const until = Date.now() + 20000;
      while (!admin) {
        if (server.exitCode !== null) throw new Error(diagnostic);
        try {
          admin = await mysql.createConnection({
            host: '127.0.0.1',
            port,
            user: 'root',
            connectTimeout: 1000,
            multipleStatements: true,
          });
        } catch (error) {
          if (Date.now() > until) throw error;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      assert.equal(admin.config.host, '127.0.0.1');
      assert.equal(admin.config.port, port);
      const fixtures = readFileSync('test/fixtures/wx-data-schema.sql', 'utf8'),
        databases = [...fixtures.matchAll(/USE `([^`]+)`;/g)].map((m) => m[1]);
      assert.equal(databases.length, 4);
      for (const name of databases) {
        assert.match(name, /^weatherdata-(skodje|hahjem|longva|vatne)$/);
        await admin.query(`CREATE DATABASE \`${name}\``);
      }
      await admin.query(fixtures);
      const password = randomBytes(24).toString('hex');
      await admin.query("CREATE USER 'wg_writer'@'localhost' IDENTIFIED BY ?", [password]);
      for (const name of databases)
        await admin.query(`GRANT SELECT,INSERT,UPDATE ON \`${name}\`.wx_data TO 'wg_writer'@'localhost'`);
      let clock = Date.now();
      const config = configuration({
        WG_ENVIRONMENT: 'production',
        WG_DB_ALLOWED_DATABASES: databases.join(','),
        WG_DB_LAN_ENDPOINTS: `127.0.0.1:${port}`,
        WG_DB_PASSWORD: password,
      });
      store = new Store({ root: join(root, 'gateway'), environment: 'production', clock: () => clock });
      initialize(store, config.defaults);
      let interrupt = true;
      const logs = [];
      writer = new WeatherDatabase(store, config, {
        logger: (e) => logs.push(e),
        poolFactory: (options) => {
          const pool = mysql.createPool(options);
          return {
            end: () => pool.end(),
            getConnection: async () => {
              const c = await pool.getConnection();
              return {
                release: () => c.release(),
                destroy: () => c.destroy(),
                execute: async (...args) => {
                  const result = await c.execute(...args);
                  if (interrupt && String(args[0].sql).startsWith('INSERT INTO wx_data')) {
                    interrupt = false;
                    throw Object.assign(new Error('simulated connection loss after remote commit'), {
                      code: 'ECONNRESET',
                      fatal: true,
                    });
                  }
                  return result;
                },
              };
            },
          };
        },
      });
      const targets = [];
      for (const { value: station } of store.stationList()) {
        const target = databaseSchema.parse({
          ...store.current(`database:${station.id}`).value,
          enabled: true,
          host: '127.0.0.1',
          port,
          transport: 'lan',
          database: `weatherdata-${station.key.toLowerCase()}`,
          user: 'wg_writer',
          stationNameColumn: station.key === 'Vatne' ? 'station_name' : null,
          columns: {
            ...databaseColumns,
            ...extendedDatabaseColumns,
            uvIndex: station.key === 'Hahjem' ? 'davis_vp_uv' : null,
            ...(station.key === 'Vatne' ? vatneDatabaseColumns : {}),
          },
        });
        targets.push({ station, target });
        assert.equal((await writer.probe(target)).database, 'ok');
      }
      const schemasBefore = await Promise.all(
        databases.map(
          async (name) => (await admin.query(`SHOW CREATE TABLE \`${name}\`.wx_data`))[0][0]['Create Table'],
        ),
      );
      for (const { station, target } of targets) {
        assert.equal((await writer.probe(target)).database, 'ok');
        const current = store.current(`database:${station.id}`),
          change = store.propose(current.scope, target, current.revision, 'test');
        store.begin(change.id, 'test');
        store.health(change.id, true, { database: 'ok' });
        store.confirm(change.id, 'test');
        const body = observation(station.id, clock);
        delete body.measurements.pressureHpa;
        body.measurements.solarWm2 = 320.6;
        ingest(store, station.id, body);
      }
      await writer.drain();
      assert.equal(
        databaseStatus(store).reduce((n, s) => n + s.pending, 0),
        1,
      );
      clock += 3000;
      await writer.drain();
      assert.equal(
        databaseStatus(store).reduce((n, s) => n + s.pending, 0),
        0,
      );
      for (const { station, target } of targets) {
        const [rows] = await admin.query(`SELECT * FROM \`${target.database}\`.wx_data`);
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.equal(row.station_id, station.key);
        assert.equal(row.barometer, 0);
        assert.equal(row.current_windchill, 0);
        assert.ok(row.dew_point_temperature > 9 && row.dew_point_temperature < 10);
        assert.equal(row.temperature, 20);
        assert.equal(row.monthly_rainfall, 0);
        assert.equal(row.yearly_rainfall, 0);
        assert.ok(Math.abs(row.average_windspeed - 14.4) < 0.00001);
        assert.equal(row.max_daily_temperature, 20);
        if (station.key === 'Vatne') {
          assert.equal(row.station_name, station.name);
          assert.equal(row.actual_solar_reading, 321);
          assert.equal(row.forecast_icon, 0);
          assert.equal(row.soil_temperature, 0);
          assert.ok(row.month >= 1 && row.month <= 12);
        }
      }
      assert.equal(
        logs.some((e) => e.code === 'ECONNRESET'),
        true,
      );
      const schemasAfter = await Promise.all(
        databases.map(
          async (name) => (await admin.query(`SHOW CREATE TABLE \`${name}\`.wx_data`))[0][0]['Create Table'],
        ),
      );
      assert.deepEqual(schemasAfter, schemasBefore);
    } catch (error) {
      error.message += `\nTemporary MariaDB diagnostic: ${diagnostic}`;
      throw error;
    } finally {
      await writer?.close();
      store?.close();
      if (admin) {
        await admin.query('SHUTDOWN').catch(() => {});
        await admin.end().catch(() => {});
      }
      if (server.exitCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      }
      const rel = relative(workspace, root);
      if (!rel.startsWith('..') && rel.startsWith('mariadb-integration-'))
        rmSync(root, { recursive: true, force: true });
    }
  },
);
