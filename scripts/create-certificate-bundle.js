// Offline first-provisioning bundle. No connection to the deployed host is made.
// Private keys stay under the chosen output directory and are never logged.
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import { resolve, join, relative, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createPublicKey, X509Certificate, randomBytes } from 'node:crypto';
import { configuration, initialize } from '../server/bootstrap.js';
import { Store, hash } from '../server/store.js';
import { CertificateIssuer, opensslExecutable } from '../server/pki.js';
import { mqttSubjectAltNames } from '../server/tls-identities.js';

const options = Object.fromEntries(
  process.argv.slice(2).map((flag) => {
    const match = /^--(output|environment|mqtt-host|mqtt-names)=(.+)$/.exec(flag);
    if (!match)
      throw new Error(
        'Bruk: node scripts/create-certificate-bundle.js --output=MAPPE --environment=production --mqtt-host=wg-api.skrg.no [--mqtt-names=IP1,IP2]',
      );
    return [match[1], match[2]];
  }),
);
if (!options.output || !['production', 'development'].includes(options.environment) || !options['mqtt-host'])
  throw new Error('Oppgi output, environment og mqtt-host eksplisitt. Utviklings-.env blir ikke brukt.');
const root = resolve(options.output),
  environment = options.environment,
  hostname = options['mqtt-host'].replace(/^\[|\]$/g, '');
const subjectAltName = mqttSubjectAltNames(hostname, options['mqtt-names'] || '');
if (existsSync(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()))
  throw new Error('Sertifikatmappen må være en vanlig mappe');
if (existsSync(join(root, 'CERTIFICATES.json')))
  throw new Error(
    'Sertifikatpakken finnes allerede. Den beholdes urørt. Bruk vedlikeholdsverktøyet for kontrollert fornyelse.',
  );
mkdirSync(root, { recursive: true, mode: 0o700 });
if (process.platform === 'win32') {
  // Limit the package to its owner and SYSTEM, including all future children.
  const sid = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  if (!/^S-1-5-(?:\d+-)*\d+$/.test(sid)) throw new Error('Kunne ikke fastslå eier for nøkkelmappen');
  execFileSync('icacls', [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], {
    stdio: 'pipe',
    windowsHide: true,
  });
} else chmodSync(root, 0o700);
const secrets = join(root, 'secrets', environment);
mkdirSync(secrets, { recursive: true, mode: 0o700 });
const expected = [
  'client-ca.key',
  'client-ca.pem',
  'server.key',
  'server.pem',
  'worker.key',
  'worker.pem',
  'firmware-signing.key',
  'firmware-signing-public.pem',
  'read-token',
];
if (expected.some((name) => existsSync(join(secrets, name))))
  throw new Error('Mappen inneholder allerede nøkler. Ingen eksisterende identitet overskrives.');
const run = (args) => {
  try {
    execFileSync(opensslExecutable, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      timeout: 15000,
    });
  } catch {
    throw new Error('OpenSSL avviste sertifikatgenereringen. Eksisterende filer er beholdt.');
  }
};
const key = (name) => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    path = join(secrets, `${name}.key`);
  writeFileSync(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o400 });
  return path;
};
const caKey = key('client-ca'),
  caPath = join(secrets, 'client-ca.pem');
run([
  'req',
  '-x509',
  '-new',
  '-key',
  caKey,
  '-days',
  '3650',
  '-sha256',
  '-set_serial',
  `0x${randomBytes(16).toString('hex')}`,
  '-subj',
  `/CN=WeatherGateway-${environment}-ClientCA`,
  '-addext',
  'basicConstraints=critical,CA:TRUE,pathlen:0',
  '-addext',
  'keyUsage=critical,keyCertSign,cRLSign',
  '-addext',
  'subjectKeyIdentifier=hash',
  '-out',
  caPath,
]);
chmodSync(caPath, 0o640);
const ca = new X509Certificate(readFileSync(caPath));
function leaf(name, cn, eku, san) {
  const keyPath = key(name),
    csr = join(secrets, `${name}.csr`),
    extensions = join(secrets, `${name}.cnf`),
    pem = join(secrets, `${name}.pem`);
  run(['req', '-new', '-key', keyPath, '-subj', `/CN=${cn}`, '-out', csr]);
  writeFileSync(
    extensions,
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n${san ? `subjectAltName=${san}\n` : ''}`,
    { flag: 'wx', mode: 0o600 },
  );
  run([
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    caPath,
    '-CAkey',
    caKey,
    '-set_serial',
    `0x${randomBytes(16).toString('hex')}`,
    '-days',
    '365',
    '-sha256',
    '-extfile',
    extensions,
    '-out',
    pem,
  ]);
  chmodSync(keyPath, name === 'server' ? 0o440 : 0o400);
  chmodSync(pem, 0o640);
  const certificate = new X509Certificate(readFileSync(pem));
  if (
    !certificate.verify(ca.publicKey) ||
    !certificate.publicKey.equals(createPublicKey(readFileSync(keyPath)))
  )
    throw new Error('Nøkkel- eller signaturkontrollen feilet');
  return certificate;
}
const server = leaf('server', hostname, 'serverAuth', subjectAltName),
  worker = leaf('worker', 'gateway-worker', 'clientAuth');
const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
writeFileSync(
  join(secrets, 'firmware-signing.key'),
  signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { flag: 'wx', mode: 0o400 },
);
const firmwarePublicKey = signing.publicKey.export({ type: 'spki', format: 'pem' });
writeFileSync(join(secrets, 'firmware-signing-public.pem'), firmwarePublicKey, { flag: 'wx', mode: 0o640 });
writeFileSync(join(secrets, 'read-token'), randomBytes(32).toString('base64url'), {
  flag: 'wx',
  mode: 0o640,
});
const temporary = mkdtempSync(join(root, '.issuer-')),
  config = configuration({
    WG_ENVIRONMENT: environment,
    WG_PUBLIC_ORIGIN: `https://${hostname.includes(':') ? `[${hostname}]` : hostname}`,
  });
let store;
try {
  store = new Store({ root: temporary, environment });
  initialize(store, config.defaults);
  const issuer = new CertificateIssuer({ store, keyFile: caKey, caFile: caPath }),
    devices = [];
  for (const station of store
    .stationList()
    .map((s) => s.value)
    .filter((s) => s.enabled && s.model !== 'Netatmo')) {
    const identity = await issuer.issue(station.id),
      directory = join(root, 'provisioning', environment, 'stations', station.id),
      device = store.confirmedValue(`device:${station.id}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, body] of [
      ['device.key', identity.privateKey],
      ['device.pem', identity.certificate],
      ['ca.pem', identity.ca],
      [
        'credentials.json',
        JSON.stringify(
          {
            ...identity,
            environment,
            configuration: device,
            configurationHash: hash(device),
            firmwarePublicKey,
            configurationSource: 'initial-defaults-verify-in-admin-before-flashing',
          },
          null,
          2,
        ) + '\n',
      ],
    ])
      writeFileSync(join(directory, name), body, { flag: 'wx', mode: 0o600 });
    devices.push({
      stationId: station.id,
      name: station.name,
      certificateId: identity.certificateId,
      fingerprint: identity.fingerprint,
      expiresAt: new Date(identity.expiresAt).toISOString(),
    });
  }
  const registration = {
    format: 'wg-device-certificates-1',
    environment,
    caFingerprint: ca.fingerprint256,
    certificates: store.db
      .prepare('SELECT * FROM certificates ORDER BY station_id')
      .all()
      .map((row) => ({
        id: row.id,
        stationId: row.station_id,
        commonName: row.common_name,
        serial: row.serial,
        certificate: row.certificate,
      })),
  };
  const imports = join(root, environment, 'system', 'certificate-import');
  mkdirSync(imports, { recursive: true, mode: 0o750 });
  writeFileSync(join(imports, 'device-certificates.json'), JSON.stringify(registration, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o640,
  });
  // These small import helpers also work with the already published image:
  // they load its existing Store/schema/PKI and resolve zod from /app.
  let transfer = readFileSync(new URL('../server/certificate-transfer.js', import.meta.url), 'utf8')
    .replace(
      "import { z } from 'zod';",
      "import { createRequire } from 'node:module';\nconst {z}=createRequire('/app/package.json')('zod');",
    )
    .replaceAll("from './schema.js'", "from '/app/server/schema.js'")
    .replaceAll("from './store.js'", "from '/app/server/store.js'")
    .replaceAll("from './pki.js'", "from '/app/server/pki.js'");
  let importer = readFileSync(new URL('./import-device-certificates.js', import.meta.url), 'utf8')
    .replaceAll("from '../server/bootstrap.js'", "from '/app/server/bootstrap.js'")
    .replaceAll("from '../server/store.js'", "from '/app/server/store.js'")
    .replaceAll("from '../server/certificate-transfer.js'", "from './certificate-transfer.mjs'");
  writeFileSync(join(imports, 'certificate-transfer.mjs'), transfer, { flag: 'wx', mode: 0o640 });
  writeFileSync(join(imports, 'import-device-certificates.mjs'), importer, { flag: 'wx', mode: 0o640 });
  const summary = {
    format: 'wg-certificate-bundle-1',
    environment,
    createdAt: new Date().toISOString(),
    installation: 'first-provisioning-only-do-not-overwrite-an-existing-host-CA',
    ca: { fingerprint: ca.fingerprint256, expiresAt: new Date(ca.validTo).toISOString() },
    server: {
      subjectAltName: server.subjectAltName,
      fingerprint: server.fingerprint256,
      expiresAt: new Date(server.validTo).toISOString(),
    },
    worker: { fingerprint: worker.fingerprint256, expiresAt: new Date(worker.validTo).toISOString() },
    devices,
  };
  writeFileSync(join(root, 'CERTIFICATES.json'), JSON.stringify(summary, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  for (const name of ['README-NO.md', 'install-first-provisioning.sh']) {
    const template = readFileSync(new URL(`../deploy/certificates/${name}`, import.meta.url), 'utf8');
    const rendered = template
      .replaceAll('__ENVIRONMENT__', environment)
      .replaceAll('__SERVER_NAMES__', server.subjectAltName)
      .replaceAll('__PUBLIC_ORIGIN__', config.defaults.publicOrigin);
    writeFileSync(join(root, name), rendered, { flag: 'wx', mode: 0o600 });
  }
  console.log(
    JSON.stringify({
      output: root,
      environment,
      serverNames: server.subjectAltName,
      deviceCertificates: devices.length,
      privateKeysLogged: false,
    }),
  );
} finally {
  store?.close();
  const rel = relative(root, resolve(temporary));
  if (!rel.startsWith('..') && basename(temporary).startsWith('.issuer-'))
    rmSync(temporary, { recursive: true, force: true });
}
