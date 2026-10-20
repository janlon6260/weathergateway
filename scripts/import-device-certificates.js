import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '../server/bootstrap.js';
import { Store } from '../server/store.js';
import { importDeviceCertificates, publishImportedCertificateAcl } from '../server/certificate-transfer.js';

const path = process.argv[2],
  config = configuration(),
  caFile = process.env.WG_ISSUER_CA_FILE;
if (!path || process.argv.length !== 3 || !caFile)
  throw new Error(
    'Bruk: node scripts/import-device-certificates.js register.json. Sett WG_ENVIRONMENT, WG_DATA_ROOT og WG_ISSUER_CA_FILE.',
  );
if (!existsSync(join(config.root, 'system', 'gateway.sqlite3')))
  throw new Error(
    'Start control med produksjonsinnstillingene først. Ingen konfigurasjon opprettes av importverktøyet.',
  );
if (statSync(path).size > 1024 * 1024) throw new Error('Sertifikatregisteret er for stort');
const store = new Store({ root: config.root, environment: config.environment });
try {
  const result = importDeviceCertificates(
    store,
    JSON.parse(readFileSync(path, 'utf8')),
    readFileSync(caFile, 'utf8'),
    'local-certificate-import',
  );
  publishImportedCertificateAcl(store);
  console.log(JSON.stringify(result));
} finally {
  store.close();
}
