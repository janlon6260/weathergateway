import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { publicProjection } from '../server/public-projection.js';
import { prepareRuntime } from '../server/runtime-files.js';
import { ingest } from '../server/observations.js';
import { setup, observation } from './helpers.js';

function denyDirectoryWrites(path) {
  if (process.platform === 'win32') {
    const sid = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    assert.match(sid, /^S-1-5-(?:\d+-)*\d+$/);
    const run = (args) => execFileSync('icacls', args, { stdio: 'pipe', windowsHide: true });
    // Deny creating WAL/SHM/journal files, while allowing reads and ACL recovery.
    run([path, '/deny', `*${sid}:(WD,AD)`]);
    return () => run([path, '/remove:d', `*${sid}`]);
  }
  chmodSync(path, 0o550);
  return () => chmodSync(path, 0o750);
}

test(
  'cold public reader opens the projected database without permission to create WAL or SHM files',
  {
    skip:
      process.platform !== 'win32' && process.getuid?.() === 0
        ? 'Root bypasses directory permission checks'
        : false,
  },
  (t) => {
    const { store, now } = setup(t),
      station = store.stationList()[0].value;
    ingest(store, station.id, observation(station.id, now()));
    // This is the actual control startup path: publish and close before public starts.
    prepareRuntime(store);
    const root = store.safe('public'),
      system = store.safe('public', 'system'),
      before = readdirSync(system).sort();
    const restorePermissions = denyDirectoryWrites(system);
    let reader;
    try {
      reader = new Store({ root, environment: 'test', readonly: true });
      assert.equal(reader.db.readonly, true);
      assert.equal(reader.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
      assert.throws(() => reader.db.prepare('DELETE FROM observations').run(), { code: 'SQLITE_READONLY' });
      assert.deepEqual(readdirSync(system).sort(), before);
    } finally {
      reader?.close();
      restorePermissions();
    }
  },
);

test('public projection migrates a closed legacy WAL database and a readonly reader sees later committed weather updates', (t) => {
  const { store, now, tick } = setup(t),
    station = store.stationList()[0].value,
    root = store.safe('public');
  const legacy = new Store({ root, environment: 'test' });
  legacy.close();
  assert.equal(readFileSync(store.safe('public', 'system', 'gateway.sqlite3'))[18], 2);
  const projection = publicProjection(store);
  let reader;
  try {
    ingest(store, station.id, observation(station.id, now()));
    projection.sync();
    assert.equal(projection.store.db.pragma('journal_mode', { simple: true }), 'delete');
    assert.equal(store.db.pragma('journal_mode', { simple: true }), 'wal');
    reader = new Store({ root, environment: 'test', readonly: true, clock: now });
    assert.equal(reader.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
    tick(2000);
    ingest(
      store,
      station.id,
      observation(station.id, now(), { sequence: 2, measurements: { temperatureC: 22 } }),
    );
    projection.sync();
    const row = reader.db.prepare('SELECT body FROM observations ORDER BY observed_at DESC LIMIT 1').get();
    assert.equal(JSON.parse(row.body).measurements.temperatureC, 22);
    assert.equal(reader.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 2);
  } finally {
    reader?.close();
    projection.close();
  }
});

test(
  'actual public process starts after control closes its projection and serves the protected weather API',
  { timeout: 15000 },
  async (t) => {
    const { store, now } = setup(t),
      station = store.stationList()[0].value;
    ingest(store, station.id, observation(station.id, now()));
    prepareRuntime(store);
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const token = 'readonly-public-regression-token-0001';
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('WG_')));
    const child = spawn(process.execPath, ['server/index.js'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        WG_ROLE: 'public',
        WG_ENVIRONMENT: 'test',
        WG_DATA_ROOT: store.safe('public'),
        WG_BIND: '127.0.0.1',
        WG_ALLOW_LOCAL_HTTP: 'true',
        WG_READ_TOKEN: token,
        PORT: String(port),
      },
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => (output = (output + data).slice(-4000)));
    try {
      let response;
      for (let i = 0; i < 80; i++) {
        assert.equal(child.exitCode, null, output);
        try {
          response = await fetch(`http://127.0.0.1:${port}/health/live`);
          if (response.ok) break;
        } catch {
          /* startup */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(response?.status, 200, output);
      assert.equal((await fetch(`http://127.0.0.1:${port}/weather/current`)).status, 401);
      const weather = await fetch(`http://127.0.0.1:${port}/weather/current`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(weather.status, 200);
      const snapshot = await weather.json();
      assert.equal(Object.hasOwn(snapshot, station.key), true);
      assert.equal(Object.keys(snapshot).length, store.stationList().length);
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  },
);
