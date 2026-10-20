import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setup } from './helpers.js';
import { scheduleBackup, finishBackups, listBackups } from '../server/backups.js';

test('automatic backups use confirmed settings, persist their schedule and retain the configured successful snapshots', async (t) => {
  const s = setup(t),
    gateway = s.store.current('gateway');
  const draft = s.store.propose(
    'gateway',
    { ...gateway.value, backupIntervalHours: 0, backupKeepCount: 2 },
    gateway.revision,
    'admin',
  );
  s.store.begin(draft.id, 'admin');
  assert.ok(scheduleBackup(s.store));
  await finishBackups(s.store);
  assert.equal(scheduleBackup(s.store), undefined);
  s.store.health(draft.id, true, {});
  s.store.confirm(draft.id, 'admin');
  s.tick(2 * 86400000);
  assert.equal(scheduleBackup(s.store), undefined);
  const disabled = s.store.current('gateway'),
    enable = s.store.propose(
      'gateway',
      { ...disabled.value, backupIntervalHours: 24 },
      disabled.revision,
      'admin',
    );
  s.store.begin(enable.id, 'admin');
  s.store.health(enable.id, true, {});
  s.store.confirm(enable.id, 'admin');
  const first = listBackups(s.store)[0].id;
  scheduleBackup(s.store);
  await finishBackups(s.store);
  s.tick(86400001);
  scheduleBackup(s.store);
  await finishBackups(s.store);
  assert.equal(listBackups(s.store).length, 2);
  assert.equal(existsSync(s.store.safe('system', 'backups', `${first}.sqlite3`)), false);
});
