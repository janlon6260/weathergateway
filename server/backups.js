import { mkdirSync, chmodSync, readdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Rejected } from './store.js';

const running = new WeakMap();
async function checksum(file) {
  const sha = createHash('sha256');
  for await (const chunk of createReadStream(file)) sha.update(chunk);
  return sha.digest('hex');
}
function directory(store) {
  const dir = store.safe('system', 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function listBackups(store) {
  directory(store);
  return readdirSync(store.safe('system', 'backups'))
    .filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))
    .slice(-100)
    .map((n) => JSON.parse(readFileSync(store.safe('system', 'backups', n), 'utf8')))
    .sort((a, b) => b.startedAt - a.startedAt);
}
export function startBackup(store, actor) {
  if (running.has(store)) throw new Rejected('En sikkerhetskopi kjører allerede');
  directory(store);
  const id = randomUUID(),
    path = store.safe('system', 'backups', `${id}.sqlite3`),
    manifest = store.safe('system', 'backups', `${id}.json`);
  const data = {
    id,
    format: 'wg-backup-1',
    environment: store.environment,
    state: 'running',
    startedAt: store.clock(),
  };
  const save = () => {
    writeFileSync(`${manifest}.tmp`, JSON.stringify(data) + '\n', { mode: 0o600 });
    renameSync(`${manifest}.tmp`, manifest);
  };
  save();
  store.audit(actor, 'backup_started', { id });
  const task = Promise.resolve().then(async () => {
    try {
      await store.db.backup(path, { progress: () => 100 });
      chmodSync(path, 0o600);
      data.sha256 = await checksum(path);
      data.state = 'complete';
      data.completedAt = store.clock();
      store.audit(actor, 'backup_complete', { id, sha256: data.sha256 });
    } catch {
      data.state = 'failed';
      store.audit(actor, 'backup_failed', { id });
    } finally {
      save();
      running.delete(store);
    }
  });
  running.set(store, task);
  return data;
}
export async function finishBackups(store) {
  await running.get(store);
}
export function recoverBackups(store) {
  for (const entry of listBackups(store).filter((b) => b.state === 'running')) {
    entry.state = 'failed';
    entry.reason = 'server_restarted';
    entry.completedAt = store.clock();
    writeFileSync(store.safe('system', 'backups', `${entry.id}.json`), JSON.stringify(entry) + '\n', {
      mode: 0o600,
    });
    store.audit('recovery', 'backup_interrupted', { id: entry.id });
  }
}
