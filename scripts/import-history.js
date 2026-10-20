import { createReadStream, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { Store } from '../server/store.js';
import { configuration, initialize } from '../server/bootstrap.js';
import { importHistory } from '../server/history-import.js';
import { normalizeHistory } from '../server/history-normalizer.js';

const [path, stationKey, ...flags] = process.argv.slice(2);
if (
  !path ||
  !stationKey ||
  flags.some(
    (f) => !/^--(?:apply|format=(?:telemetry|wx-data)|wind-unit=(?:kmh|ms)|fold=(?:earlier|later))$/.test(f),
  )
)
  throw new Error(
    'Bruk: node --env-file-if-exists=.env scripts/import-history.js data.jsonl STASJONSNØKKEL [--format=wx-data --wind-unit=kmh --fold=earlier] [--apply]',
  );
const option = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.split('=')[1];
const options = {
    format: option('format') || 'telemetry',
    windUnit: option('wind-unit'),
    fold: option('fold'),
  },
  apply = flags.includes('--apply');
const config = configuration(),
  store = new Store({ root: config.root, environment: config.environment });
initialize(store, config.defaults);
const actor = `local-admin:${userInfo().username}`,
  jobId = randomUUID();
let line = 0,
  total = 0,
  inserted = 0,
  duplicates = 0,
  batch = [];
try {
  const station = store.stationList().find((s) => s.value.key === stationKey)?.value;
  if (!station) throw new Error('Stasjonen finnes ikke');
  const provenance = join(store.stationDirectory(station.id, 'diagnostics'), `history-import-${jobId}.jsonl`);
  const flush = () => {
    if (!batch.length) return;
    const request = { format: 'wg-history-1', stationId: station.id, dryRun: true, observations: batch };
    const preview = importHistory(store, request, actor);
    if (apply) {
      const result = importHistory(store, { ...request, dryRun: false, previewId: preview.previewId }, actor);
      inserted += result.inserted;
      duplicates += result.duplicates;
      if (result.failed.length)
        throw new Error(`Importen stoppet etter ${inserted} nye rader; se audit og kildefilen.`);
    }
    total += batch.length;
    batch = [];
  };
  for await (const text of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    line++;
    if (!text.trim()) continue;
    if (text.length > 65536) throw new Error(`Linje ${line} er for stor`);
    const row = JSON.parse(text),
      normalized = normalizeHistory(row, station.id, { ...options, stationKey: station.key });
    if (apply)
      appendFileSync(
        provenance,
        JSON.stringify({
          jobId,
          line,
          source: row,
          identity: { bootId: normalized.bootId, sequence: normalized.sequence },
        }) + '\n',
        { mode: 0o600 },
      );
    batch.push(normalized);
    if (batch.length === 250) flush();
  }
  flush();
  console.log(
    JSON.stringify({
      jobId,
      dryRun: !apply,
      records: total,
      inserted,
      duplicates,
      externalDatabaseWrites: false,
    }),
  );
} finally {
  store.close();
}
