import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, basename } from 'node:path';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { id } from './schema.js';
import { Rejected } from './store.js';

const execute = promisify(execFile);
export const opensslExecutable =
  process.env.WG_OPENSSL ||
  (process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
    ? 'C:/Program Files/Git/usr/bin/openssl.exe'
    : 'openssl');
export class CertificateIssuer {
  constructor({ keyFile, caFile, store, openssl = opensslExecutable }) {
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
  async renew(stationId, certificateId) {
    const previous = this.store.db
      .prepare(
        'SELECT * FROM certificates WHERE id=? AND station_id=? AND revoked_at IS NULL AND expires_at>?',
      )
      .get(id.parse(certificateId), id.parse(stationId), this.store.clock());
    if (!previous) throw new Rejected('Sertifikatet kan ikke fornyes', 403);
    const directory = await mkdtemp(join(resolve(tmpdir()), 'wg-cert-'));
    try {
      await chmod(directory, 0o700);
      const publicKey = join(directory, 'public.pem'),
        extensions = join(directory, 'extensions.cnf'),
        path = join(directory, 'renewed.pem');
      await writeFile(
        publicKey,
        new X509Certificate(previous.certificate).publicKey.export({ type: 'spki', format: 'pem' }),
      );
      await writeFile(
        extensions,
        'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n',
      );
      const serial = randomBytes(16).toString('hex'),
        commonName = `${stationId}.${serial.slice(0, 16)}`;
      await execute(
        this.openssl,
        [
          'x509',
          '-new',
          '-force_pubkey',
          publicKey,
          '-subj',
          `/CN=${commonName}`,
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
          path,
        ],
        { timeout: 10000, windowsHide: true },
      );
      // Recheck revocation after signing, before granting a replacement identity.
      const current = this.store.db
        .prepare('SELECT revoked_at FROM certificates WHERE id=?')
        .get(certificateId);
      if (current?.revoked_at !== null) throw new Rejected('Sertifikatet ble sperret under fornyelsen', 403);
      const certificate = await readFile(path, 'utf8'),
        x509 = new X509Certificate(certificate),
        replacementId = randomUUID();
      this.store.db
        .prepare('INSERT INTO certificates VALUES (?,?,?,?,?,?,NULL)')
        .run(replacementId, stationId, commonName, serial, Date.parse(x509.validTo), certificate);
      syncAcl(this.store);
      return { certificateId: replacementId, certificate, expiresAt: x509.validTo };
    } finally {
      const rel = relative(resolve(tmpdir()), resolve(directory));
      if (!rel.startsWith('..') && !rel.includes('..') && basename(directory).startsWith('wg-cert-'))
        await rm(directory, { recursive: true, force: true });
    }
  }
}

export function requestCertificateRenewal(store, stationId, certificateId, { force = false } = {}) {
  const cert = store.db
    .prepare('SELECT * FROM certificates WHERE id=? AND station_id=? AND revoked_at IS NULL AND expires_at>?')
    .get(id.parse(certificateId), id.parse(stationId), store.clock());
  if (!cert) throw new Rejected('Sertifikatet kan ikke fornyes', 403);
  if (!force && cert.expires_at > store.clock() + 21 * 86400000) return false;
  const pending = store.db.prepare('SELECT * FROM certificate_renewals WHERE station_id=?').get(stationId);
  if (
    pending &&
    (['queued', 'issuing', 'sent'].includes(pending.state) ||
      (pending.certificate_id === certificateId && store.clock() - pending.created_at < 3600000))
  )
    return false;
  store.db
    .prepare("INSERT OR REPLACE INTO certificate_renewals VALUES (?,?,NULL,'queued',?,NULL,NULL)")
    .run(stationId, certificateId, store.clock());
  return true;
}
export function renewalProcessor(store, issuer) {
  let running = false;
  store.db.prepare("UPDATE certificate_renewals SET state='queued' WHERE state='issuing'").run();
  return async () => {
    if (running || !issuer) return;
    running = true;
    try {
      store.db
        .prepare(
          "UPDATE certificate_renewals SET state='failed',error='DELIVERY_EXPIRED' WHERE state='sent' AND command_id IN (SELECT id FROM commands WHERE state IN ('expired','rejected','rolled_back','cancelled'))",
        )
        .run();
      const request = store.db
        .prepare("SELECT * FROM certificate_renewals WHERE state='queued' ORDER BY created_at LIMIT 1")
        .get();
      if (!request) return;
      store.db
        .prepare("UPDATE certificate_renewals SET state='issuing' WHERE station_id=?")
        .run(request.station_id);
      try {
        const replacement = await issuer.renew(request.station_id, request.certificate_id);
        store.db
          .transaction(() => {
            const commandId = store.queueCommand(
              request.station_id,
              'renew_certificate',
              {
                certificateId: replacement.certificateId,
                previousCertificateId: request.certificate_id,
                certificate: replacement.certificate,
              },
              store.clock() + 300000,
            );
            store.db
              .prepare(
                "UPDATE certificate_renewals SET state='sent',new_id=?,command_id=? WHERE station_id=?",
              )
              .run(replacement.certificateId, commandId, request.station_id);
            store.audit('certificate-renewal', 'certificate_renewal_sent', {
              stationId: request.station_id,
              certificateId: replacement.certificateId,
            });
          })
          .immediate();
      } catch (error) {
        store.db
          .prepare("UPDATE certificate_renewals SET state='failed',error=? WHERE station_id=?")
          .run(error instanceof Rejected ? 'RENEWAL_REJECTED' : 'RENEWAL_FAILED', request.station_id);
      }
    } finally {
      running = false;
    }
  };
}

export function syncAcl(store) {
  const directory = store.safe('system', 'mqtt');
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  const root = `wg/v1/${store.environment}/stations`;
  let acl = `# Managed by Weather Gateway. Default deny.\nuser gateway-worker\ntopic read ${root}/+/telemetry\ntopic read ${root}/+/acks\ntopic read ${root}/+/status\ntopic read ${root}/+/firmware-request\ntopic write ${root}/+/firmware-data\ntopic write ${root}/+/commands\n`;
  const enabled = new Set(
    store
      .stationList()
      .map((s) => store.confirmedConfiguration(s.scope))
      .filter((s) => s.value.enabled)
      .map((s) => s.value.id),
  );
  for (const cert of store.db
    .prepare('SELECT * FROM certificates WHERE revoked_at IS NULL AND expires_at>? ORDER BY common_name')
    .all(store.clock())) {
    if (!enabled.has(cert.station_id)) continue;
    acl += `\nuser ${cert.common_name}\ntopic write ${root}/${cert.station_id}/telemetry\ntopic write ${root}/${cert.station_id}/acks\ntopic write ${root}/${cert.station_id}/status\ntopic write ${root}/${cert.station_id}/firmware-request\ntopic read ${root}/${cert.station_id}/firmware-data\ntopic read ${root}/${cert.station_id}/commands\n`;
  }
  const path = store.safe('system', 'mqtt', 'acl');
  acl = acl.replace(
    `topic read ${root}/+/telemetry\n`,
    `topic read ${root}/+/telemetry\ntopic read ${root}/+/telemetry-undated\ntopic read ${root}/+/certificate-request\ntopic write ${root}/+/telemetry-receipt\n`,
  );
  for (const stationId of enabled)
    acl = acl.replaceAll(
      `topic write ${root}/${stationId}/telemetry\n`,
      `topic write ${root}/${stationId}/telemetry\ntopic write ${root}/${stationId}/telemetry-undated\ntopic write ${root}/${stationId}/certificate-request\ntopic read ${root}/${stationId}/telemetry-receipt\n`,
    );
  if (!existsSync(path) || readFileSync(path, 'utf8') !== acl) {
    writeFileSync(`${path}.tmp`, acl, { mode: 0o640 });
    renameSync(`${path}.tmp`, path);
  }
}
