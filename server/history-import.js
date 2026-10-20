import { z } from 'zod';
import { telemetrySchema, id } from './schema.js';
import { ingest } from './observations.js';
import { Rejected, hash } from './store.js';
import { randomUUID } from 'node:crypto';
export const historyImportSchema = z
  .object({
    format: z.literal('wg-history-1'),
    stationId: id,
    dryRun: z.boolean().default(true),
    previewId: id.optional(),
    observations: z.array(telemetrySchema).min(1).max(250),
  })
  .strict();
export function importHistory(store, input, actor) {
  const batch = historyImportSchema.parse(input),
    station = store.confirmedValue(`station:${batch.stationId}`);
  if (!station.enabled) throw new Rejected('Aktiver stasjonen før historikkimport', 409);
  const threshold = Date.UTC(1900, 0, 1);
  for (const body of batch.observations) {
    if (
      body.stationId !== batch.stationId ||
      Date.parse(body.observedAt) > store.clock() + 60000 ||
      Date.parse(body.observedAt) < threshold
    )
      throw new Rejected('Historikkens stasjon eller måletid er ugyldig', 400);
    if (body.source)
      throw new Rejected('Importer normaliserte historikkmålinger; rå radiopakker leveres via MQTT', 400);
  }
  const result = {
    dryRun: batch.dryRun,
    stationId: batch.stationId,
    records: batch.observations.length,
    inserted: 0,
    duplicates: 0,
    failed: [],
    externalDatabaseWrites: false,
    batchHash: hash(batch.observations),
  };
  if (batch.dryRun) {
    result.previewId = randomUUID();
    result.expiresAt = store.clock() + store.timeoutSeconds() * 1000;
    store.db
      .prepare('INSERT INTO import_previews VALUES (?,?,?,?,?,0)')
      .run(result.previewId, batch.stationId, result.batchHash, result.expiresAt, actor);
  } else {
    const preview = store.db
      .prepare(
        'UPDATE import_previews SET consumed=1 WHERE id=? AND station_id=? AND batch_hash=? AND actor=? AND expires_at>? AND consumed=0 RETURNING id',
      )
      .get(batch.previewId || '', batch.stationId, result.batchHash, actor, store.clock());
    if (!preview) throw new Rejected('Forhåndsvis importen på nytt før den gjøres gjeldende', 409);
  }
  if (!batch.dryRun)
    for (const [index, body] of batch.observations.entries()) {
      try {
        if (ingest(store, batch.stationId, body, { enqueueDatabase: false, historical: true }))
          result.inserted++;
        else result.duplicates++;
      } catch (error) {
        result.failed.push({ index, code: error.code || error.name });
        break;
      }
    }
  store.audit(actor, batch.dryRun ? 'history_import_preview' : 'history_imported', {
    stationId: batch.stationId,
    batchHash: result.batchHash,
    records: result.records,
    inserted: result.inserted,
    duplicates: result.duplicates,
    failed: result.failed.length,
  });
  return result;
}
