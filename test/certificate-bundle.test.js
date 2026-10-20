import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate, createPublicKey } from 'node:crypto';
import { setup } from './helpers.js';
import { configuration, initialize } from '../server/bootstrap.js';
import { Store } from '../server/store.js';
import { importDeviceCertificates } from '../server/certificate-transfer.js';

test('offline certificate bundle covers server, worker and four unique stations without touching AD/DB or replacing keys', (t) => {
  const s = setup(t),
    root = join(s.store.root, 'certificates');
  const args = [
    'scripts/create-certificate-bundle.js',
    `--output=${root}`,
    '--environment=development',
    '--mqtt-host=127.0.0.1',
    '--mqtt-names=192.168.25.10',
  ];
  execFileSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const dir = join(root, 'secrets', 'development'),
    ca = new X509Certificate(readFileSync(join(dir, 'client-ca.pem'))),
    server = new X509Certificate(readFileSync(join(dir, 'server.pem'))),
    worker = new X509Certificate(readFileSync(join(dir, 'worker.pem')));
  assert.equal(server.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(server.checkIP('192.168.25.10'), '192.168.25.10');
  assert.equal(server.checkHost('broker'), 'broker');
  assert.equal(server.verify(ca.publicKey), true);
  assert.deepEqual(server.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.deepEqual(worker.keyUsage, ['1.3.6.1.5.5.7.3.2']);
  assert.equal(ca.ca, true);
  assert.equal(ca.verify(ca.publicKey), true);
  assert.equal(worker.verify(ca.publicKey), true);
  assert.equal(existsSync(join(dir, 'ad-ca.pem')), false);
  assert.equal(existsSync(join(dir, 'db-ca.pem')), false);
  assert.equal(existsSync(join(dir, 'ldap-password')), false);
  assert.equal(existsSync(join(root, 'install-first-provisioning.sh')), true);
  assert.equal(
    readFileSync(join(root, 'install-first-provisioning.sh'), 'utf8').includes('__ENVIRONMENT__'),
    false,
  );
  const registration = JSON.parse(
    readFileSync(
      join(root, 'development', 'system', 'certificate-import', 'device-certificates.json'),
      'utf8',
    ),
  );
  assert.equal(registration.certificates.length, 4);
  const keys = new Set();
  for (const cert of registration.certificates) {
    const identity = JSON.parse(
      readFileSync(
        join(root, 'provisioning', 'development', 'stations', cert.stationId, 'credentials.json'),
        'utf8',
      ),
    );
    const x509 = new X509Certificate(identity.certificate);
    assert.equal(x509.verify(ca.publicKey), true);
    assert.equal(x509.publicKey.equals(createPublicKey(identity.privateKey)), true);
    keys.add(x509.publicKey.export({ type: 'spki', format: 'pem' }));
    assert.equal(identity.environment, 'development');
    assert.equal(identity.stationId, identity.configuration.stationId);
  }
  assert.equal(keys.size, 4);
  const target = new Store({ root: join(root, 'test-target'), environment: 'development' });
  try {
    initialize(target, configuration({ WG_ENVIRONMENT: 'development' }).defaults);
    assert.equal(importDeviceCertificates(target, registration, ca.toString(), 'tester').imported, 4);
  } finally {
    target.close();
  }
  const keyBefore = readFileSync(join(dir, 'client-ca.key'));
  assert.throws(() =>
    execFileSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  );
  assert.deepEqual(readFileSync(join(dir, 'client-ca.key')), keyBefore);
});
