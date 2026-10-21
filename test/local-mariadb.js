import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join, dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
export async function localMariaDB(t) {
  const base = resolve('artifacts');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'startup-mariadb-'));
  const binary = resolve(process.env.WG_MARIADB_BIN),
    data = join(root, 'temporary-mariadb');
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
    { windowsHide: true, stdio: 'ignore' },
  );
  let connection;
  t.after(async () => {
    await connection?.end();
    if (server.exitCode === null) {
      const closed = new Promise((r) => server.once('exit', r));
      server.kill();
      await closed;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (let i = 0; i < 100 && !connection; i++)
    try {
      connection = await mysql.createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        connectTimeout: 500,
      });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  if (!connection) throw new Error('Isolated MariaDB could not start');
  return {
    WG_CONFIG_DB_HOST: '127.0.0.1',
    WG_CONFIG_DB_PORT: String(port),
    WG_CONFIG_DB_USER: 'root',
    WG_CONFIG_DB_DATABASE: 'weathergateway_development',
    WG_CONFIG_DB_PASSWORD: '',
  };
}
