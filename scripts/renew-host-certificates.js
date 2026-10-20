// Run on the host as maintenance. No Docker socket or CA key is exposed to public.
// Replacing a file bind mount requires recreating the affected containers.
import { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, chownSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { mqttSubjectAltNames } from '../server/tls-identities.js';

const flags = process.argv.slice(2);
if (
  flags.some((flag) => !['--apply', '--force'].includes(flag)) ||
  (flags.includes('--force') && !flags.includes('--apply'))
)
  throw new Error('Bruk: node scripts/renew-host-certificates.js [--apply [--force]]');
const environment = process.env.WG_ENVIRONMENT;
if (!['production', 'development'].includes(environment)) throw new Error('Sett riktig WG_ENVIRONMENT');
const directory = resolve(process.env.WG_HOST_ROOT || '/data/req/weathergateway', 'secrets', environment),
  openssl = process.env.WG_OPENSSL || 'openssl';
const caPath = join(directory, 'client-ca.pem'),
  caKey = join(directory, 'client-ca.key'),
  ca = new X509Certificate(readFileSync(caPath));
const now = Date.now(),
  apply = flags.includes('--apply'),
  staged = [],
  cleanup = [];
const run = (args) => {
  try {
    return execFileSync(openssl, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    throw new Error('OpenSSL avviste sertifikatfornyelsen. Ingen privatnøkkel er logget.');
  }
};
const status = [];
try {
  if (!ca.ca || !ca.verify(ca.publicKey) || Date.parse(ca.validFrom) > now || Date.parse(ca.validTo) <= now)
    throw new Error('CA er ugyldig eller utløpt');
  for (const name of ['server', 'worker']) {
    const path = join(directory, `${name}.pem`),
      key = join(directory, `${name}.key`),
      old = new X509Certificate(readFileSync(path));
    const renew = flags.includes('--force') || Date.parse(old.validTo) - now < 30 * 86400000;
    status.push({ name, expiresAt: new Date(old.validTo).toISOString(), renewalNeeded: renew });
    if (!apply || !renew) continue;
    if (Date.parse(ca.validTo) - now < 366 * 86400000)
      throw new Error('CA må roteres kontrollert før et nytt ettårssertifikat kan utstedes');
    const publicKey = createPublicKey(readFileSync(key));
    if (!old.publicKey.equals(publicKey) || !old.verify(ca.publicKey))
      throw new Error(`Identiteten for ${name} stemmer ikke med eksisterende nøkkel og CA`);
    const prefix = join(directory, `.renew-${randomUUID()}`),
      csr = `${prefix}.csr`,
      ext = `${prefix}.cnf`,
      pending = `${prefix}.pem`;
    cleanup.push(csr, ext, pending);
    let hostname;
    if (name === 'server') {
      hostname = new URL(process.env.WG_PUBLIC_ORIGIN || 'https://wg-api.skrg.no').hostname.replace(
        /^\[|\]$/g,
        '',
      );
      mqttSubjectAltNames(hostname, process.env.WG_MQTT_SERVER_NAMES || '');
    }
    run(['req', '-new', '-key', key, '-subj', `/CN=${hostname || 'gateway-worker'}`, '-out', csr]);
    writeFileSync(
      ext,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${name === 'server' ? 'serverAuth' : 'clientAuth'}\n${hostname ? `subjectAltName=${mqttSubjectAltNames(hostname, process.env.WG_MQTT_SERVER_NAMES || '')}\n` : ''}`,
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
      ext,
      '-out',
      pending,
    ]);
    const replacement = new X509Certificate(readFileSync(pending));
    if (
      !replacement.publicKey.equals(publicKey) ||
      !replacement.verify(ca.publicKey) ||
      (hostname && !(isIP(hostname) ? replacement.checkIP(hostname) : replacement.checkHost(hostname)))
    )
      throw new Error('Nytt sertifikat bestod ikke nøkkel-, CA- eller navnekontrollen');
    chmodSync(pending, 0o640);
    if (process.platform !== 'win32') chownSync(pending, 10001, 10001);
    staged.push({ name, path, pending });
  }
  for (const entry of staged) {
    writeFileSync(join(directory, `${entry.name}.previous.pem`), readFileSync(entry.path), { mode: 0o640 });
    renameSync(entry.pending, entry.path);
  }
  console.log(
    JSON.stringify({
      environment,
      dryRun: !apply,
      certificates: status,
      renewed: staged.map((entry) => entry.name),
      recreateContainers: staged.length ? ['broker', 'worker'] : [],
    }),
  );
} finally {
  for (const path of cleanup) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
