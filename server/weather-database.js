import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { databaseSchema } from './schema.js';
import { Rejected, hash } from './store.js';
import { databaseTargetHash } from './database-queue.js';
import { lanTransport } from './database-transport.js';
import { calendarDatabaseMetrics } from '../shared/database-columns.js';

const errorCode = (error) =>
  error instanceof Rejected
    ? 'DB_CONFIGURATION_INVALID'
    : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
      ? error.code
      : 'DB_CHECK_FAILED';
const quote = (name) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error('Ugyldig databasekolonne');
  return `\`${name}\``;
};
export function databaseInsert(row) {
  const columns = Object.keys(row);
  // Existing observations remain authoritative. A retry after an uncertain
  // commit or an older backup cannot overwrite already stored weather data.
  return {
    sql: `INSERT INTO wx_data (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE station_id=station_id`,
    values: Object.values(row),
  };
}
export class WeatherDatabase {
  constructor(
    store,
    config,
    { poolFactory = mysql.createPool, logger = (entry) => console.error(JSON.stringify(entry)) } = {},
  ) {
    this.store = store;
    this.config = config;
    this.poolFactory = poolFactory;
    this.logger = logger;
    this.pools = new Map();
    this.closed = false;
    this.running = null;
    this.cleanup = setInterval(() => {
      for (const [key, entry] of this.pools)
        if (!entry.borrowed && Date.now() - entry.used > 120000) {
          this.pools.delete(key);
          void entry.pool.end().catch(() => {});
        }
    }, 60000);
    this.cleanup.unref();
  }
  options(input) {
    const target = databaseSchema.parse(input);
    if (!target.enabled) throw new Rejected('Databaseskriving er deaktivert', 409);
    if (!(this.config.databaseAllowlist || []).includes(target.database))
      throw new Rejected('Databasen er ikke tillatt i WG_DB_ALLOWED_DATABASES for dette miljøet', 409);
    if (this.store.environment !== 'production' && !target.database.startsWith('wg_dev_'))
      throw new Rejected('Utvikling kan bare bruke isolerte databaser med prefikset wg_dev_', 409);
    const password = this.config.databasePasswords?.[target.passwordEnv];
    if (!password) throw new Rejected(`Databasepassord mangler i ${target.passwordEnv}`, 409);
    let transport;
    if (target.transport === 'lan') transport = lanTransport(target, this.config.databaseLanEndpoints);
    else {
      const ca = this.config.databaseCaFile ? readFileSync(this.config.databaseCaFile, 'utf8').trim() : '';
      const certFile = this.config.databaseCertFile,
        keyFile = this.config.databaseKeyFile;
      if (!!certFile !== !!keyFile)
        throw new Rejected('Databaseklient krever både sertifikat og privatnøkkel.');
      const identity = certFile
        ? { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') }
        : {};
      transport = {
        ssl: {
          rejectUnauthorized: true,
          verifyIdentity: true,
          minVersion: 'TLSv1.2',
          ...(ca ? { ca } : {}),
          ...identity,
        },
      };
    }
    return {
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password,
      connectTimeout: 5000,
      connectionLimit: 2,
      maxIdle: 1,
      idleTimeout: 60000,
      waitForConnections: false,
      enableKeepAlive: true,
      dateStrings: true,
      timezone: 'Z',
      ...transport,
    };
  }
  async connection(target, operation) {
    if (this.closed) throw new Rejected('Databasearbeideren stopper', 503);
    const options = this.options(target),
      key = hash(options);
    let entry = this.pools.get(key);
    if (!entry) {
      entry = { pool: this.poolFactory(options), borrowed: 0, used: Date.now(), checkedAt: 0 };
      this.pools.set(key, entry);
    }
    entry.borrowed++;
    let connection;
    try {
      connection = await entry.pool.getConnection();
      const execute = async (sql, values = []) => {
        try {
          return await connection.execute({ sql, timeout: 5000 }, values);
        } catch (error) {
          if (error.fatal || error.code === 'PROTOCOL_SEQUENCE_TIMEOUT') connection.destroy();
          throw error;
        }
      };
      return await operation(execute, entry);
    } finally {
      connection?.release();
      entry.borrowed--;
      entry.used = Date.now();
    }
  }
  async inspect(execute, target) {
    const [columns] = await execute(
      "SELECT COLUMN_NAME AS name,IS_NULLABLE AS nullable,DATA_TYPE AS type,COLUMN_DEFAULT AS defaultValue,EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wx_data'",
    );
    const byName = new Map(columns.map((column) => [column.name, column]));
    const required = [
      'station_id',
      'date',
      'time',
      ...Object.values(target.columns).filter(Boolean),
      ...(target.stationNameColumn ? [target.stationNameColumn] : []),
    ];
    const missing = required.filter((name) => !byName.has(name));
    if (missing.length) throw new Rejected(`wx_data mangler kolonner: ${missing.join(', ')}`, 409);
    if (byName.get('date').type !== 'date' || byName.get('time').type !== 'time')
      throw new Rejected('wx_data må bruke DATE og TIME for eksisterende lokal tidskontrakt', 409);
    if (
      target.stationNameColumn &&
      !['varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext'].includes(
        byName.get(target.stationNameColumn).type,
      )
    )
      throw new Rejected('Kolonnen for stasjonsnavn må kunne lagre tekst', 409);
    const numericTypes = ['decimal', 'float', 'double', 'tinyint', 'smallint', 'mediumint', 'int', 'bigint'];
    for (const [metric, name] of Object.entries(target.columns).filter(([, name]) => Boolean(name)))
      if (
        (!calendarDatabaseMetrics.has(metric) && byName.get(name).nullable !== 'YES') ||
        !numericTypes.includes(byName.get(name).type)
      )
        throw new Rejected(`Målekolonnen ${name} må være numerisk og tillate NULL`, 409);
    if (
      columns.some(
        (column) =>
          !required.includes(column.name) &&
          column.nullable === 'NO' &&
          column.defaultValue === null &&
          !/auto_increment|GENERATED/i.test(column.extra),
      )
    )
      throw new Rejected('wx_data har påkrevde kolonner uten feltkobling eller standardverdi', 409);
    const [indexes] = await execute(
      "SELECT INDEX_NAME AS name,COLUMN_NAME AS columnName,SUB_PART AS prefixLength FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wx_data' AND NON_UNIQUE=0 ORDER BY INDEX_NAME,SEQ_IN_INDEX",
    );
    const keys = new Map();
    for (const row of indexes) keys.set(row.name, [...(keys.get(row.name) || []), row]);
    const natural = (rows) =>
      rows.every((row) => !row.prefixLength) &&
      ['date,time', 'date,station_id,time'].includes(
        rows
          .map((row) => row.columnName)
          .sort()
          .join(','),
      );
    if (![...keys.values()].some(natural))
      throw new Rejected(
        'wx_data trenger en unik nøkkel på date/time eller station_id/date/time for sikker gjentakelse',
        409,
      );
    for (const rows of keys.values())
      if (
        !natural(rows) &&
        !rows.every((row) => /auto_increment/i.test(byName.get(row.columnName)?.extra || ''))
      )
        throw new Rejected('wx_data har en ekstra unik nøkkel som kan skjule nye observasjoner', 409);
    const [modes] = await execute('SELECT @@SESSION.sql_mode AS mode');
    if (!/(?:^|,)STRICT_(?:ALL|TRANS)_TABLES(?:,|$)/.test(modes[0]?.mode || ''))
      throw new Rejected(
        'Databasesesjonen må bruke streng SQL-modus for å unngå stille datakonvertering',
        409,
      );
    // Confirms read access without exposing observation rows.
    await execute(`SELECT ${required.map(quote).join(',')} FROM wx_data LIMIT 0`);
    return {
      database: 'ok',
      table: 'wx_data',
      uniqueKey: 'ok',
      writePerformed: false,
      integerColumns: required.filter((name) =>
        ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(byName.get(name).type),
      ),
    };
  }
  async probe(target) {
    if (!target.enabled) return { database: 'disabled', writePerformed: false };
    try {
      return await this.connection(target, (execute) => this.inspect(execute, target));
    } catch (error) {
      if (error instanceof Rejected) throw error;
      throw new Rejected(`Databasetesten feilet (${errorCode(error)})`, 409);
    }
  }
  drain() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = Promise.allSettled(
      this.store.configurations('database:').map((item) => this.deliver(item.scope)),
    )
      .then((results) => {
        for (const result of results)
          if (result.status === 'rejected')
            this.logger({ event: 'database_worker_failed', code: errorCode(result.reason) });
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  async deliver(scope) {
    const target = this.store.confirmedValue(scope),
      targetHash = databaseTargetHash(target);
    if (!target.enabled || !this.store.confirmedValue(`station:${target.stationId}`).enabled) return;
    const first = this.store.db
      .prepare(
        'SELECT * FROM database_outbox WHERE station_id=? AND target_hash=? ORDER BY observed_at,id LIMIT 1',
      )
      .get(target.stationId, targetHash);
    if (!first || first.next_attempt > this.store.clock() || first.lease_until > this.store.clock()) return;
    let current = first;
    let leasedUntil = null;
    try {
      await this.connection(target, async (execute, entry) => {
        if (Date.now() - entry.checkedAt > 300000) {
          const report = await this.inspect(execute, target);
          entry.integerColumns = report.integerColumns;
          entry.checkedAt = Date.now();
        }
        for (let count = 0; count < 20 && !this.closed; count++) {
          const active = this.store.confirmedValue(scope);
          if (
            !active.enabled ||
            hash(active) !== hash(target) ||
            !this.store.confirmedValue(`station:${target.stationId}`).enabled
          )
            break;
          current = this.store.db
            .prepare(
              'SELECT * FROM database_outbox WHERE station_id=? AND target_hash=? ORDER BY observed_at,id LIMIT 1',
            )
            .get(target.stationId, targetHash);
          if (
            !current ||
            current.next_attempt > this.store.clock() ||
            current.lease_until > this.store.clock()
          )
            break;
          leasedUntil = this.store.clock() + 15000;
          const claimed = this.store.db
            .prepare('UPDATE database_outbox SET lease_until=? WHERE id=? AND lease_until<=?')
            .run(leasedUntil, current.id, this.store.clock()).changes;
          if (!claimed) break;
          const row = JSON.parse(current.row_json);
          for (const name of entry.integerColumns || [])
            if (typeof row[name] === 'number')
              row[name] = row[name] < 0 ? -Math.round(-row[name]) : Math.round(row[name]);
          const statement = databaseInsert(row);
          await execute(statement.sql, statement.values);
          this.store.db
            .transaction(() => {
              const removed = this.store.db
                .prepare('DELETE FROM database_outbox WHERE id=? AND lease_until=?')
                .run(current.id, leasedUntil).changes;
              if (!removed) return;
              this.store.db
                .prepare(
                  'UPDATE database_delivery SET last_delivered_at=MAX(COALESCE(last_delivered_at,0),?),last_error=NULL WHERE station_id=? AND target_hash=?',
                )
                .run(current.observed_at, target.stationId, targetHash);
            })
            .immediate();
          leasedUntil = null;
        }
      });
    } catch (error) {
      if (!current) return;
      const code = errorCode(error),
        attempts = current.attempts + 1;
      const changed = this.store.db
        .prepare(
          'UPDATE database_outbox SET attempts=?,next_attempt=?,lease_until=0,last_error=? WHERE id=? AND (lease_until=? OR (? IS NULL AND lease_until<=?))',
        )
        .run(
          attempts,
          this.store.clock() + Math.min(300000, 1000 * 2 ** Math.min(attempts, 9)),
          code,
          current.id,
          leasedUntil,
          leasedUntil,
          this.store.clock(),
        ).changes;
      if (!changed) return;
      this.store.db
        .prepare('UPDATE database_delivery SET last_error=? WHERE station_id=? AND target_hash=?')
        .run(code, target.stationId, targetHash);
      this.logger({ event: 'database_delivery_failed', stationId: target.stationId, code });
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.cleanup);
    await this.running;
    await Promise.allSettled([...this.pools.values()].map((entry) => entry.pool.end()));
    this.pools.clear();
  }
}
