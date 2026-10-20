import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { setup } from './helpers.js';
import {
  CertificateIssuer,
  opensslExecutable,
  requestCertificateRenewal,
  renewalProcessor,
} from '../server/pki.js';
import { handleAck } from '../server/worker.js';

test('renewal keeps the private key on the device and retires the old certificate only after authenticated device confirmation', async (t) => {
  const { store } = setup(t),
    stationId = store.stationList()[0].value.id;
  const keyFile = join(store.root, 'ca.key'),
    caFile = join(store.root, 'ca.pem');
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
      '/CN=Renewal-Test-CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const issuer = new CertificateIssuer({ store, keyFile, caFile }),
    previous = await issuer.issue(stationId);
  assert.equal(requestCertificateRenewal(store, stationId, previous.certificateId), false);
  assert.equal(requestCertificateRenewal(store, stationId, previous.certificateId, { force: true }), true);
  await renewalProcessor(store, issuer)();
  const command = store.db.prepare("SELECT * FROM commands WHERE kind='renew_certificate'").get(),
    payload = JSON.parse(command.payload);
  assert.equal(Object.hasOwn(payload, 'privateKey'), false);
  const before = new X509Certificate(previous.certificate),
    after = new X509Certificate(payload.certificate);
  assert.deepEqual(
    before.publicKey.export({ type: 'spki', format: 'der' }),
    after.publicKey.export({ type: 'spki', format: 'der' }),
  );
  assert.equal(
    store.db.prepare('SELECT revoked_at FROM certificates WHERE id=?').get(previous.certificateId).revoked_at,
    null,
  );
  handleAck(store, stationId, {
    version: 1,
    stationId,
    commandId: command.id,
    status: 'applied',
    certificateId: payload.certificateId,
  });
  assert.equal(
    store.db.prepare('SELECT revoked_at FROM certificates WHERE id=?').get(previous.certificateId).revoked_at,
    store.clock(),
  );
  assert.equal(
    store.db.prepare('SELECT state FROM certificate_renewals WHERE station_id=?').get(stationId).state,
    'applied',
  );
  assert.throws(
    () => requestCertificateRenewal(store, stationId, previous.certificateId, { force: true }),
    /kan ikke fornyes/,
  );
});
