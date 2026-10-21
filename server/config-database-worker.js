import { workerData } from 'node:worker_threads';
import mysql from 'mysql2/promise';
import { lanTransport } from './database-transport.js';
const { port, gate, connection: options, tables, environment } = workerData;
const signal = new Int32Array(gate);
const quote = (name) => '`' + name.replaceAll('`', '``') + '`';
let connection,
  depth = 0;
let transactionBroken = false;
async function connect() {
  if (transactionBroken)
    throw Object.assign(new Error('Transaction connection lost'), { code: 'WG_CONFIG_TRANSACTION_LOST' });
  if (connection) return connection;
  const { database, ...base } = options;
  const c = await mysql.createConnection({
    ...base,
    ...(!base.ssl ? lanTransport(base, [`${base.host}:${base.port}`]) : {}),
    connectTimeout: 5000,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    flags: ['-FOUND_ROWS'],
    dateStrings: true,
  });
  try {
    await c.query(
      `CREATE DATABASE IF NOT EXISTS ${quote(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
    );
    await c.changeUser({ database });
    await c.query(
      "SET SESSION sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
    );
    await c.query('SET SESSION innodb_lock_wait_timeout=10');
    c.on('error', () => {
      if (depth) transactionBroken = true;
      connection = null;
    });
    connection = c;
    return c;
  } catch (e) {
    c.destroy();
    throw e;
  }
}
async function query(sql, args = []) {
  try {
    return (await (await connect()).query({ sql, timeout: 10000 }, args))[0];
  } catch (error) {
    if (error.fatal || error.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
      if (depth) transactionBroken = true;
      connection?.destroy();
      connection = null;
    }
    throw error;
  }
}
function schema(table) {
  const singleIntegerKey = table.columns.find(
    (c) => c.pk && c.type === 'INTEGER' && table.columns.filter((v) => v.pk).length === 1,
  );
  const indexed = new Set(table.indexes.flatMap((i) => i.columns));
  const fields = table.columns.map((c) => {
    let type =
      c.type === 'INTEGER'
        ? 'BIGINT'
        : c.type === 'REAL'
          ? 'DOUBLE'
          : indexed.has(c.name) || c.pk
            ? 'VARCHAR(191)'
            : 'LONGTEXT';
    if (table.name === 'firmware_releases' && c.name === 'manifest') type = 'LONGTEXT';
    return `${quote(c.name)} ${type}${c.notnull || c.pk ? ' NOT NULL' : ''}${singleIntegerKey?.name === c.name ? ' AUTO_INCREMENT' : ''}${c.dflt_value !== null && type !== 'LONGTEXT' ? ' DEFAULT ' + c.dflt_value : ''}`;
  });
  const pk = table.columns
    .filter((c) => c.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => quote(c.name));
  if (pk.length) fields.push(`PRIMARY KEY (${pk.join(',')})`);
  if (!singleIntegerKey) fields.push('`_wg_rowid` BIGINT NOT NULL AUTO_INCREMENT UNIQUE');
  for (const index of table.indexes) {
    if (index.origin === 'pk') continue;
    if (index.partial && table.name === 'changes') {
      fields.push(
        "`_wg_active_scope` VARCHAR(191) GENERATED ALWAYS AS (CASE WHEN state IN ('draft','testing','confirming') THEN scope ELSE NULL END) STORED",
      );
      fields.push('UNIQUE KEY `one_change` (`_wg_active_scope`)');
      continue;
    }
    if (table.name === 'firmware_releases' && index.columns.includes('manifest')) {
      fields.push('`_wg_manifest_hash` CHAR(64) GENERATED ALWAYS AS (SHA2(manifest,256)) STORED');
      fields.push('UNIQUE KEY `manifest_identity` (`station_id`,`_wg_manifest_hash`)');
      continue;
    }
    fields.push(
      `${index.unique ? 'UNIQUE ' : ''}KEY ${quote(index.name.replaceAll('sqlite_autoindex_', 'wg_'))} (${index.columns.map(quote).join(',')})`,
    );
  }
  return `CREATE TABLE IF NOT EXISTS ${quote(table.name)} (${fields.join(',')}) ENGINE=InnoDB`;
}
async function initialize(legacy) {
  await connect();
  for (const table of tables) await query(schema(table));
  const existing = await query('SELECT value FROM meta WHERE `key`=?', ['environment']);
  if (existing.length && existing[0].value !== environment)
    throw Object.assign(new Error('Database belongs to another environment'), {
      code: 'WG_ENVIRONMENT_MISMATCH',
    });
  await begin();
  try {
    const count = await query('SELECT COUNT(*) AS total FROM configuration');
    if (!count[0].total) {
      for (const table of tables) {
        const columns = table.columns.map((c) => c.name),
          rows = legacy[table.name] || [];
        for (const row of rows)
          await query(
            `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE ${quote(columns[0])}=${quote(columns[0])}`,
            columns.map((c) => row[c]),
          );
      }
    }
    await commit();
  } catch (e) {
    await rollback();
    throw e;
  }
}
async function begin() {
  if (depth) {
    await query(`SAVEPOINT wg_${depth}`);
    depth++;
    return;
  }
  const rows = await query('SELECT GET_LOCK(?,10) AS acquired', [`wg:${options.database}:settings`]);
  if (rows[0].acquired !== 1)
    throw Object.assign(new Error('Configuration busy'), { code: 'WG_CONFIG_BUSY' });
  try {
    await (await connect()).beginTransaction();
    depth = 1;
  } catch (e) {
    await query('SELECT RELEASE_LOCK(?)', [`wg:${options.database}:settings`]);
    throw e;
  }
}
async function commit() {
  if (transactionBroken)
    throw Object.assign(new Error('Transaction connection lost'), { code: 'WG_CONFIG_TRANSACTION_LOST' });
  if (depth > 1) {
    depth--;
    await query(`RELEASE SAVEPOINT wg_${depth}`);
    return;
  }
  if (depth) {
    try {
      await connection.commit();
    } finally {
      depth = 0;
      await query('SELECT RELEASE_LOCK(?)', [`wg:${options.database}:settings`]);
    }
  }
}
async function rollback() {
  if (transactionBroken) {
    connection?.destroy();
    connection = null;
    depth = 0;
    transactionBroken = false;
    return;
  }
  if (!connection) {
    depth = 0;
    return;
  }
  if (depth > 1) {
    depth--;
    await query(`ROLLBACK TO SAVEPOINT wg_${depth}`);
    return;
  }
  if (depth) {
    try {
      await connection.rollback();
    } finally {
      depth = 0;
      await query('SELECT RELEASE_LOCK(?)', [`wg:${options.database}:settings`]);
    }
  }
}
port.on('message', async (request) => {
  try {
    let result;
    if (request.method === 'initialize') result = await initialize(request.legacy);
    else if (request.method === 'begin') result = await begin();
    else if (request.method === 'commit') result = await commit();
    else if (request.method === 'rollback') result = await rollback();
    else if (request.method === 'close') {
      await connection?.end();
      connection = null;
      result = true;
    } else result = await query(request.sql, request.args);
    port.postMessage({ result });
  } catch (error) {
    port.postMessage({
      error: {
        code: error.code || 'WG_CONFIG_DB_ERROR',
        message:
          error.code === 'WG_ENVIRONMENT_MISMATCH'
            ? 'Konfigurasjonsdatabasen tilhører et annet miljø'
            : 'MariaDB for innstillinger svarte ikke eller avviste forespørselen',
      },
    });
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
});
