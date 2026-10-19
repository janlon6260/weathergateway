import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, basename } from 'node:path';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { id } from './schema.js';

const execute = promisify(execFile);
export class CertificateIssuer {
  constructor({ keyFile, caFile, store, openssl = process.env.WG_OPENSSL || 'openssl' }) {
    this.keyFile = keyFile;
    this.caFile = caFile;
    this.store = store;
    this.openssl = openssl;
  }
  async issue(stationId) {
    id.parse(stationId);
    const tempRoot = resolve(tmpdir()),
      directory = await mkdtemp(join(tempRoot, 'wg-cert-'));
    try {
      await chmod(directory, 0o700);
      const privateKey = join(directory, 'device.key'),
        csr = join(directory, 'device.csr'),
        cert = join(directory, 'device.pem'),
        extensions = join(directory, 'extensions.cnf');
      await writeFile(
        extensions,
        'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n',
      );
      const serial = randomBytes(16).toString('hex'),
        commonName = `${stationId}.${serial.slice(0, 16)}`;
      await execute(
        this.openssl,
        [
          'req',
          '-new',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-keyout',
          privateKey,
          '-out',
          csr,
          '-subj',
          `/CN=${commonName}`,
        ],
        { timeout: 10000, windowsHide: true },
      );
      await execute(
        this.openssl,
        [
          'x509',
          '-req',
          '-in',
          csr,
          '-CA',
          this.caFile,
          '-CAkey',
          this.keyFile,
          '-set_serial',
          `0x${serial}`,
          '-days',
          '90',
          '-sha256',
          '-extfile',
          extensions,
          '-out',
          cert,
        ],
        { timeout: 10000, windowsHide: true },
      );
      const certificate = await readFile(cert, 'utf8'),
        x509 = new X509Certificate(certificate);
      const certificateId = randomUUID();
      this.store.db
        .prepare('INSERT INTO certificates VALUES (?,?,?,?,?,?,NULL)')
        .run(certificateId, stationId, commonName, serial, Date.parse(x509.validTo), certificate);
      syncAcl(this.store);
      return {
        certificateId,
        stationId,
        certificate,
        privateKey: await readFile(privateKey, 'utf8'),
        ca: await readFile(this.caFile, 'utf8'),
        fingerprint: x509.fingerprint256,
        expiresAt: x509.validTo,
      };
    } finally {
      const rel = relative(tempRoot, resolve(directory));
      if (!rel.startsWith('..') && !rel.includes('..') && basename(directory).startsWith('wg-cert-'))
        await rm(directory, { recursive: true, force: true });
    }
  }
}

export function syncAcl(store) {
  const directory = store.safe('system', 'mqtt');
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  const root = `wg/v1/${store.environment}/stations`;
  let acl = `# Managed by Weather Gateway. Default deny.\nuser gateway-worker\ntopic read ${root}/+/telemetry\ntopic read ${root}/+/acks\ntopic read ${root}/+/status\ntopic write ${root}/+/commands\n`;
  const enabled = new Set(
    store
      .stationList()
      .filter((s) => s.value.enabled)
      .map((s) => s.value.id),
  );
  for (const cert of store.db
    .prepare('SELECT * FROM certificates WHERE revoked_at IS NULL AND expires_at>? ORDER BY common_name')
    .all(store.clock())) {
    if (!enabled.has(cert.station_id)) continue;
    acl += `\nuser ${cert.common_name}\ntopic write ${root}/${cert.station_id}/telemetry\ntopic write ${root}/${cert.station_id}/acks\ntopic write ${root}/${cert.station_id}/status\ntopic read ${root}/${cert.station_id}/commands\n`;
  }
  const path = store.safe('system', 'mqtt', 'acl');
  if (!existsSync(path) || readFileSync(path, 'utf8') !== acl) {
    writeFileSync(`${path}.tmp`, acl, { mode: 0o640 });
    renameSync(`${path}.tmp`, path);
  }
}
