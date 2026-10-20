import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { setup } from './helpers.js';
import { CertificateIssuer, opensslExecutable } from '../server/pki.js';
import { importDeviceCertificates, publishImportedCertificateAcl } from '../server/certificate-transfer.js';

async function fixtures(t) {
  const s = setup(t);
  s.tick(Date.now() - s.now() + 1000);
  const keyFile = join(s.store.root, 'ca.key'),
    caFile = join(s.store.root, 'ca.pem');
  execFileSync(
    opensslExecutable,
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '365',
      '-keyout',
      keyFile,
      '-out',
      caFile,
      '-subj',
      '/CN=WG-transfer-test',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const issuer = new CertificateIssuer({ store: s.store, keyFile, caFile });
  for (const station of s.store.stationList().slice(0, 2)) await issuer.issue(station.value.id);
  s.tick(Date.now() - s.now());
  const ca = readFileSync(caFile, 'utf8'),
    rows = s.store.db.prepare('SELECT * FROM certificates').all();
  const manifest = {
    format: 'wg-device-certificates-1',
    environment: 'test',
    caFingerprint: new X509Certificate(ca).fingerprint256,
    certificates: rows.map((r) => ({
      id: r.id,
      stationId: r.station_id,
      commonName: r.common_name,
      serial: r.serial,
      certificate: r.certificate,
    })),
  };
  s.store.db.prepare('DELETE FROM certificates').run();
  return { ...s, ca, manifest };
}
test('offline device certificates are imported idempotently and grant only their original station topics', async (t) => {
  const s = await fixtures(t),
    before = s.store.current('gateway');
  assert.equal(importDeviceCertificates(s.store, s.manifest, s.ca, 'tester').imported, 2);
  assert.equal(importDeviceCertificates(s.store, s.manifest, s.ca, 'tester').existing, 2);
  publishImportedCertificateAcl(s.store);
  const acl = readFileSync(s.store.safe('system', 'mqtt', 'acl'), 'utf8');
  assert.ok(acl.includes(`user ${s.manifest.certificates[0].commonName}`));
  assert.deepEqual(s.store.current('gateway'), before);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM certificates').get().n, 2);
});
test('offline certificate import rejects foreign environment, station substitution and revoked collisions atomically', async (t) => {
  const s = await fixtures(t);
  assert.throws(
    () => importDeviceCertificates(s.store, { ...s.manifest, environment: 'production' }, s.ca, 'tester'),
    /Miljø/,
  );
  const changed = structuredClone(s.manifest);
  changed.certificates[0].stationId = changed.certificates[1].stationId;
  assert.throws(() => importDeviceCertificates(s.store, changed, s.ca, 'tester'), /identitet/);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM certificates').get().n, 0);
  importDeviceCertificates(s.store, s.manifest, s.ca, 'tester');
  s.store.db
    .prepare('UPDATE certificates SET revoked_at=? WHERE id=?')
    .run(s.store.clock(), s.manifest.certificates[1].id);
  s.store.db.prepare('DELETE FROM certificates WHERE id=?').run(s.manifest.certificates[0].id);
  assert.throws(() => importDeviceCertificates(s.store, s.manifest, s.ca, 'tester'), /sperret/);
  assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM certificates').get().n, 1);
});
