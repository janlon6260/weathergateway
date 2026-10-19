import {
  mkdirSync,
  existsSync,
  writeFileSync,
  chmodSync,
  chownSync,
  readFileSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { configuration, initialize } from '../server/bootstrap.js';
import { Store } from '../server/store.js';
import { syncAcl } from '../server/pki.js';
import { publicProjection } from '../server/public-projection.js';

const environment = process.env.WG_ENVIRONMENT;
if (!['production', 'development'].includes(environment))
  throw new Error('Sett WG_ENVIRONMENT til production eller development');
const root = resolve(process.env.WG_HOST_ROOT || '/data/req/weathergateway'),
  data = join(root, environment),
  secrets = join(root, 'secrets', environment);
const openssl = process.env.WG_OPENSSL || 'openssl';
const config = configuration();
function owner(path, mode, uid = 10001) {
  chmodSync(path, mode);
  if (process.platform !== 'win32') chownSync(path, uid, 10001);
}
function dir(path, uid = 10001) {
  mkdirSync(path, { recursive: true, mode: 0o750 });
  owner(path, 0o750, uid);
}
dir(data);
dir(secrets);
const caKey = join(secrets, 'client-ca.key'),
  ca = join(secrets, 'client-ca.pem');
function command(args) {
  execFileSync(openssl, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
}
if (!existsSync(caKey)) {
  command([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '3650',
    '-keyout',
    caKey,
    '-out',
    ca,
    '-subj',
    `/CN=WeatherGateway-${environment}-ClientCA`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
}
if (!existsSync(ca))
  throw new Error('CA-privatnøkkel finnes uten CA-sertifikat. Avbryter uten overskriving.');
owner(caKey, 0o400);
owner(ca, 0o640);
function leaf(name, commonName, extensions) {
  const key = join(secrets, `${name}.key`),
    pem = join(secrets, `${name}.pem`),
    csr = join(secrets, `${name}.csr`),
    ext = join(secrets, `${name}.cnf`);
  if (!existsSync(key)) {
    command([
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      csr,
      '-subj',
      `/CN=${commonName}`,
    ]);
    writeFileSync(
      ext,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n${extensions}\n`,
      { mode: 0o600 },
    );
    command([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      ca,
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
      pem,
    ]);
  }
  if (!existsSync(pem)) throw new Error(`Nøkkel finnes uten sertifikat: ${name}`);
  owner(key, name === 'server' ? 0o440 : 0o400);
  owner(pem, 0o640);
}
const hostname = new URL(config.defaults.publicOrigin).hostname;
if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Ugyldig DNS-navn');
leaf('server', hostname, `extendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname},DNS:broker`);
leaf('worker', 'gateway-worker', 'extendedKeyUsage=clientAuth');
for (const name of ['ldap-password', 'read-token']) {
  const path = join(secrets, name);
  if (!existsSync(path))
    writeFileSync(path, name === 'read-token' ? randomBytes(32).toString('base64url') : '', { mode: 0o640 });
  owner(path, 0o640);
}
const store = new Store({ root: data, environment });
initialize(store, config.defaults);
syncAcl(store);
const projection = publicProjection(store);
projection.sync();
projection.close();
store.close();
for (const name of ['.environment', 'system/gateway.sqlite3']) owner(join(data, name), 0o640);
for (const name of ['system', 'stations', 'system/mqtt']) dir(join(data, name));
dir(join(data, 'system/mqtt/data'), 1883);
const brokerConfig = `listener 8883\nprotocol mqtt\nallow_anonymous false\nrequire_certificate true\nuse_identity_as_username true\nuse_username_as_clientid true\ncafile /mosquitto/certs/client-ca.pem\ncertfile /mosquitto/certs/server.pem\nkeyfile /mosquitto/certs/server.key\ntls_version tlsv1.2\nacl_file /mosquitto/config/acl\npersistence true\npersistence_location /mosquitto/data/\nautosave_interval 30\nlog_dest stdout\nmax_connections 100\nmax_packet_size 32768\nmessage_size_limit 16384\nmax_queued_messages 100\nmax_inflight_messages 20\n`;
writeFileSync(join(data, 'system/mqtt/mosquitto.conf'), brokerConfig);
owner(join(data, 'system/mqtt/mosquitto.conf'), 0o640);
owner(join(data, 'system/mqtt/acl'), 0o640);
writeFileSync(
  join(data, 'system/mqtt/broker-entrypoint.sh'),
  readFileSync(new URL('../deploy/broker-entrypoint.sh', import.meta.url)),
);
owner(join(data, 'system/mqtt/broker-entrypoint.sh'), 0o750);
// Bootstrap runs as root on Linux. Files created indirectly by SQLite and the
// weather projection must also belong to the runtime users, not to root.
if (process.platform !== 'win32') {
  const pending = [data, secrets],
    brokerData = join(data, 'system', 'mqtt', 'data');
  while (pending.length) {
    const path = pending.pop(),
      info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('Symbolske lenker er ikke tillatt i administrerte datamapper');
    chownSync(path, path === brokerData || path.startsWith(brokerData + '/') ? 1883 : 10001, 10001);
    if (info.isDirectory()) for (const item of readdirSync(path)) pending.push(join(path, item));
  }
}
console.log(
  `Klargjort ${environment} under ${root}. Legg AD-bindpassord i secrets/${environment}/ldap-password og riktig AD-CA i secrets/${environment}/ad-ca.pem. Ingen hemmeligheter er skrevet til terminalen.`,
);
