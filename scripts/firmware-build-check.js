// Generates disposable DEVELOPMENT credentials for compilation only. The
// resulting firmware cannot authenticate to either deployed environment.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configuration, initialize } from '../server/bootstrap.js';
import { Store } from '../server/store.js';
import { CertificateIssuer, opensslExecutable } from '../server/pki.js';
import { generateKeyPairSync } from 'node:crypto';

mkdirSync('artifacts', { recursive: true });
const root = mkdtempSync(resolve('artifacts/firmware-check-')),
  openssl = opensslExecutable;
const key = join(root, 'ca.key'),
  ca = join(root, 'ca.pem');
execFileSync(
  openssl,
  [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '2',
    '-keyout',
    key,
    '-out',
    ca,
    '-subj',
    '/CN=WeatherGateway-Build-Test-Only',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
);
const store = new Store({ root: join(root, 'data'), environment: 'development' });
try {
  initialize(
    store,
    configuration({ WG_ENVIRONMENT: 'development', WG_PUBLIC_ORIGIN: 'https://firmware-build.invalid' })
      .defaults,
  );
  const stationId = store.stationList()[0].value.id,
    deviceConfiguration = store.current(`device:${stationId}`).value;
  const issuer = new CertificateIssuer({ store, keyFile: key, caFile: ca, openssl });
  const bundle = await issuer.issue(stationId),
    path = join(root, 'bundle.json');
  writeFileSync(
    path,
    JSON.stringify({
      ...bundle,
      environment: 'development',
      configuration: deviceConfiguration,
      firmwarePublicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
    }),
    { mode: 0o600 },
  );
  execFileSync(process.execPath, ['scripts/provision-firmware.js', path], {
    env: {
      ...process.env,
      WG_WIFI_SSID: 'WG-BUILD-TEST-ONLY',
      WG_WIFI_PASSWORD: 'build-test-only-credentials',
    },
    stdio: 'inherit',
    windowsHide: true,
  });
} finally {
  store.close();
}
