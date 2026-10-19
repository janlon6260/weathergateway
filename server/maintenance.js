import { readdirSync, unlinkSync, statfsSync, writeFileSync, renameSync } from 'node:fs';
import { DateTime } from 'luxon';
import { periodReport } from './observations.js';

// Each pass has a bounded SQL batch. Daily aggregates and audit are retained.
export function maintain(store, { pruneRaw = false } = {}) {
  const days = store.confirmedValue('gateway').retentionDays,
    threshold = store.clock() - days * 86400000;
  const removed = store.db
    .prepare(
      'DELETE FROM observations WHERE rowid IN (SELECT rowid FROM observations WHERE observed_at<? LIMIT 2000)',
    )
    .run(threshold).changes;
  store.db
    .prepare(
      "DELETE FROM commands WHERE created_at<? AND state NOT IN ('queued','sent','received','testing')",
    )
    .run(store.clock() - 90 * 86400000);
  if (pruneRaw)
    for (const station of store.stationList()) {
      const dir = store.stationDirectory(station.value.id, 'raw');
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
        // Keep the whole UTC file if any part of its day is inside retention.
        if (Date.parse(entry.name.slice(0, 10) + 'T00:00:00Z') + 86400000 < threshold)
          unlinkSync(store.safe('stations', station.value.id, 'raw', entry.name));
      }
    }
  return { observationsRemoved: removed };
}
export function writeReports(store) {
  const local = DateTime.fromMillis(store.clock(), { zone: 'Europe/Oslo' });
  for (const station of store.stationList().filter((s) => s.value.enabled))
    for (const period of [
      local.toFormat('yyyy-MM'),
      local.toFormat('yyyy'),
      local.minus({ months: 1 }).toFormat('yyyy-MM'),
    ]) {
      const file = store.safe('stations', station.value.id, 'reports', `${period}.json`);
      store.stationDirectory(station.value.id, 'reports');
      writeFileSync(`${file}.tmp`, JSON.stringify(periodReport(store, station.value.id, period)) + '\n', {
        mode: 0o640,
      });
      renameSync(`${file}.tmp`, file);
    }
}
export function storageHealth(store) {
  const disk = statfsSync(store.root),
    total = disk.blocks * disk.bsize,
    available = disk.bavail * disk.bsize;
  return {
    totalBytes: total,
    availableBytes: available,
    freePercent: total ? (available / total) * 100 : 0,
    writable: !store.readonly,
  };
}
