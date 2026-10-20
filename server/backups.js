import {
  mkdirSync,
  chmodSync,
  readdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
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
export function listBackups(store, { limit = 100 } = {}) {
  directory(store);
  return readdirSync(store.safe('system', 'backups'))
    .filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))
    .map((n) => {
      const entry = JSON.parse(readFileSync(store.safe('system', 'backups', n), 'utf8'));
      if (entry.id !== n.slice(0, -5))
        throw new Rejected('Sikkerhetskopiens manifestidentitet er ugyldig', 503);
      return entry;
    })
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}
export function scheduleBackup(store) {
  if (running.has(store)) return;
  const settings = store.confirmedValue('gateway'),
    hours = settings.backupIntervalHours ?? 24;
  if (!hours) return;
  const entries = listBackups(store, { limit: Infinity }),
    latest = entries.find((b) => b.state === 'complete');
  const attempt = entries[0],
    now = store.clock();
  if (latest && now - latest.completedAt < hours * 3600000) return;
  if (attempt && now - attempt.startedAt < Math.min(hours, 1) * 3600000) return;
  return startBackup(store, 'backup-scheduler');
}
function pruneBackups(store) {
  const keep = store.confirmedValue('gateway').backupKeepCount ?? 30;
  for (const entry of listBackups(store, { limit: Infinity })
    .filter((b) => b.state === 'complete')
    .slice(keep)) {
    // Only names validated by listBackups and their matching snapshot are removed.
    unlinkSync(store.safe('system', 'backups', `${entry.id}.sqlite3`));
    unlinkSync(store.safe('system', 'backups', `${entry.id}.json`));
    store.audit('backup-scheduler', 'backup_retention_removed', { id: entry.id });
  }
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
      if (data.state === 'complete') {
        try {
          pruneBackups(store);
        } catch {
          store.audit('backup-scheduler', 'backup_retention_failed', {});
        }
      }
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
