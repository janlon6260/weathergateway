import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { setup } from './helpers.js';
import { CertificateIssuer, syncAcl } from '../server/pki.js';

const openssl =
  process.env.WG_OPENSSL ||
  (process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
    ? 'C:/Program Files/Git/usr/bin/openssl.exe'
    : 'openssl');
test('real device certificate is signed with client-only usage and bound to its own topics', async (t) => {
  const { store } = setup(t),
    keyFile = join(store.root, 'ca.key'),
    caFile = join(store.root, 'ca.pem');
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
      '1',
      '-keyout',
      keyFile,
      '-out',
      caFile,
      '-subj',
      '/CN=WG-test-CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const stationId = store.stationList()[0].value.id,
    issuer = new CertificateIssuer({ store, keyFile, caFile, openssl }),
    cert = await issuer.issue(stationId);
  const x509 = new X509Certificate(cert.certificate),
    ca = new X509Certificate(readFileSync(caFile));
  assert.equal(x509.verify(ca.publicKey), true);
  assert.equal(x509.ca, false);
  assert.ok(x509.keyUsage.includes('1.3.6.1.5.5.7.3.2'));
  assert.ok(!x509.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
  let acl = readFileSync(store.safe('system', 'mqtt', 'acl'), 'utf8');
  const cn = x509.subject.replace(/^CN=/, '');
  assert.ok(acl.includes(`user ${cn}`));
  assert.ok(acl.includes(`topic read wg/v1/test/stations/${stationId}/commands`));
  store.db.prepare('UPDATE certificates SET revoked_at=? WHERE id=?').run(store.clock(), cert.certificateId);
  syncAcl(store);
  acl = readFileSync(store.safe('system', 'mqtt', 'acl'), 'utf8');
  assert.ok(!acl.includes(`user ${cn}`));
});
