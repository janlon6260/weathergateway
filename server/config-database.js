import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import Database from 'better-sqlite3';

export const configurationTables = new Set([
  'meta',
  'configuration',
  'changes',
  'audit',
  'sessions',
  'commands',
  'certificates',
  'firmware_releases',
  'firmware_builds',
  'certificate_renewals',
  'deployment_acceptance',
  'settings_secrets',
  'notification_outbox',
  'notification_state',
]);
const quote = (s) => '`' + s.replaceAll('`', '``') + '`';
export class ConfigurationDatabase {
  constructor(local, connection, environment) {
    if (
      !/^(?:weathergateway(?:_[a-z0-9_]+)?|wg_test_[a-z0-9_]+)$/.test(connection.database) ||
      (environment !== 'production' && connection.database === 'weathergateway')
    )
      throw new Error(
        'Bruk weathergateway i produksjon og en egen weathergateway_development-database i utvikling',
      );
    this.local = local;
    this.environment = environment;
    this.backend = 'mariadb';
    this.tables = [...configurationTables]
      .filter((name) => local.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
      .map((name) => ({
        name,
        columns: local.pragma(`table_info(${name})`),
        indexes: local.pragma(`index_list(${name})`).map((index) => ({
          ...index,
          columns: local.pragma(`index_info(${index.name})`).map((c) => c.name),
        })),
      }));
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.gate = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(new URL('./config-database-worker.js', import.meta.url), {
      workerData: {
        connection,
        tables: this.tables,
        environment,
        port: channel.port2,
        gate: this.gate.buffer,
      },
      transferList: [channel.port2],
    });
    this.worker.unref();
    try {
      this.call({
        method: 'initialize',
        legacy: Object.fromEntries(
          this.tables.map((t) => [t.name, local.prepare(`SELECT * FROM ${t.name}`).all()]),
        ),
      });
      // The local database keeps weather/diagnostic data. Settings are authoritative
      // in MariaDB and are never silently saved locally after migration.
      local
        .transaction(() => {
          for (const table of this.tables) local.prepare(`DELETE FROM ${table.name}`).run();
        })
        .immediate();
    } catch (error) {
      this.worker.terminate();
      this.port.close();
      throw error;
    }
  }
  call(request) {
    if (this.failure) throw this.failure;
    Atomics.store(this.gate, 0, 0);
    this.port.postMessage(request);
    const timeout = request.method === 'initialize' ? 120000 : 30000;
    if (Atomics.wait(this.gate, 0, 0, timeout) === 'timed-out') {
      this.failure = Object.assign(new Error('Konfigurasjonsdatabasen svarte ikke innen tidsgrensen'), {
        code: 'WG_CONFIG_DB_TIMEOUT',
      });
      this.port.close();
      void this.worker.terminate();
      throw this.failure;
    }
    let message;
    for (let i = 0; i < 100 && !message; i++) {
      message = receiveMessageOnPort(this.port)?.message;
      if (!message) Atomics.wait(this.gate, 0, 1, 1);
    }
    if (!message) throw new Error('Mangler svar fra konfigurasjonsdatabasen');
    if (message.error) throw Object.assign(new Error(message.error.message), { code: message.error.code });
    return message.result;
  }
  central(sql) {
    const plain = sql.replace(/'(?:''|[^'])*'/g, "''");
    return [...plain.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:\w+\.)?[`"]?(\w+)/gi)].some((m) =>
      configurationTables.has(m[1]),
    );
  }
  translate(sql) {
    const tableName = sql.match(/INSERT(?: OR \w+)? INTO\s+(\w+)/i)?.[1];
    const table = this.tables.find((t) => t.name === tableName);
    let translated = sql.replace(/\browid\b/gi, '_wg_rowid').replace(/(?<![\w`])key(?![\w`])/gi, '`key`');
    if (table)
      translated = translated.replace(
        /(INTO\s+\w+)\s+VALUES\b/i,
        `$1 (${table.columns.map((c) => quote(c.name)).join(',')}) VALUES`,
      );
    translated = translated.replace(/INSERT OR REPLACE/gi, 'REPLACE').replace(/INSERT OR IGNORE/gi, 'INSERT');
    translated = translated
      .replace(/ON CONFLICT\s*\([^)]*\)\s+DO UPDATE SET/gi, 'ON DUPLICATE KEY UPDATE')
      .replace(/excluded\.(\w+)/g, (_, name) => `VALUES(${quote(name)})`);
    translated = translated
      .replace(
        /MAX\(CAST\(meta.value AS INTEGER\),CAST\(VALUES\(`value`\) AS INTEGER\)\)/g,
        'GREATEST(CAST(meta.value AS SIGNED),CAST(VALUES(`value`) AS SIGNED))',
      )
      .replace(/ AS INTEGER\b/g, ' AS SIGNED')
      .replace(/ AS TEXT\b/g, ' AS CHAR');
    translated = translated.replace(/MAX\((CAST\(value AS SIGNED\)),\?\)/gi, 'GREATEST($1,?)');
    translated = translated.replace(
      /json_extract\(([^,()]+),('[^']+')\)/gi,
      (_, doc, path) =>
        `CASE WHEN JSON_TYPE(JSON_EXTRACT(${doc},${path}))='NULL' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(${doc},${path})) END`,
    );
    if (/INSERT OR IGNORE/i.test(sql) && table) {
      const first = table.columns.find((c) => c.pk)?.name || table.columns[0].name;
      translated += ` ON DUPLICATE KEY UPDATE ${quote(first)}=${quote(first)}`;
    }
    return translated;
  }
  prepare(sql) {
    if (!this.central(sql)) return this.local.prepare(sql);
    const translated = this.translate(sql);
    const query = (args) => this.call({ method: 'query', sql: translated, args });
    return {
      run: (...args) => {
        const r = query(args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
        return { changes: r.affectedRows || 0, lastInsertRowid: r.insertId || 0 };
      },
      get: (...args) => query(args)?.[0],
      all: (...args) => query(args),
    };
  }
  exec(sql) {
    for (const statement of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (this.central(statement)) this.call({ method: 'query', sql: this.translate(statement), args: [] });
      else this.local.exec(statement);
    }
    return this;
  }
  pragma(...args) {
    return this.local.pragma(...args);
  }
  transaction(fn) {
    const run = (...args) => {
      const localRun = this.local.transaction(() => {
        this.call({ method: 'begin' });
        try {
          const result = fn(...args);
          this.call({ method: 'commit' });
          return result;
        } catch (error) {
          try {
            this.call({ method: 'rollback' });
          } catch {}
          throw error;
        }
      });
      return localRun.immediate();
    };
    run.immediate = run;
    run.deferred = run;
    run.exclusive = run;
    return run;
  }
  async backup(path, options) {
    const settings = this.exportSettings();
    await this.local.backup(path, options);
    const snapshot = new Database(path);
    try {
      snapshot
        .transaction(() => {
          for (const table of this.tables) {
            snapshot.prepare(`DELETE FROM ${quote(table.name)}`).run();
            const columns = table.columns.map((c) => c.name);
            const insert = snapshot.prepare(
              `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
            );
            for (const row of settings.tables[table.name]) insert.run(...columns.map((c) => row[c]));
          }
        })
        .immediate();
      snapshot.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      snapshot.close();
    }
  }
  importSettings(snapshot) {
    if (
      snapshot.format !== 'wg-settings-1' ||
      snapshot.tables.meta?.find((r) => r.key === 'environment')?.value !== this.environment
    )
      throw new Error('Innstillingskopien tilhører et annet miljø');
    this.transaction(() => {
      for (const table of this.tables) {
        const rows = snapshot.tables[table.name];
        if (!Array.isArray(rows)) throw new Error(`Innstillingskopien mangler ${table.name}`);
        this.prepare(`DELETE FROM ${table.name}`).run();
        const columns = table.columns.map((c) => c.name);
        const insert = this.prepare(
          `INSERT INTO ${table.name} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        );
        for (const row of rows) insert.run(...columns.map((c) => row[c]));
      }
    }).immediate();
  }
  exportSettings() {
    this.call({ method: 'begin' });
    try {
      return {
        format: 'wg-settings-1',
        tables: Object.fromEntries(
          this.tables.map((t) => [
            t.name,
            this.prepare(`SELECT * FROM ${t.name}`)
              .all()
              .map((row) => Object.fromEntries(t.columns.map((c) => [c.name, row[c.name]]))),
          ]),
        ),
      };
    } finally {
      this.call({ method: 'commit' });
    }
  }
  close() {
    try {
      if (!this.failure) this.call({ method: 'close' });
    } finally {
      this.port.close();
      void this.worker.terminate();
      this.local.close();
    }
  }
}
