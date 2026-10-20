import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { setup } from './helpers.js';

test('host certificate maintenance supports IP SAN, preserves identity keys and requires explicit apply', (t) => {
  const { store } = setup(t),
    openssl =
      process.env.WG_OPENSSL ||
      (process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
        ? 'C:/Program Files/Git/usr/bin/openssl.exe'
        : 'openssl');
  const env = {
    ...process.env,
    WG_ENVIRONMENT: 'development',
    WG_HOST_ROOT: store.root,
    WG_PUBLIC_ORIGIN: 'https://192.168.15.10',
    WG_MQTT_SERVER_NAMES: '192.168.15.11',
    WG_OPENSSL: openssl,
  };
  const run = (script, args = []) =>
    execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8', windowsHide: true });
  run('scripts/bootstrap-host.js');
  const dir = join(store.root, 'secrets', 'development'),
    path = join(dir, 'server.pem'),
    before = new X509Certificate(readFileSync(path)),
    key = readFileSync(join(dir, 'server.key'));
  const preview = JSON.parse(run('scripts/renew-host-certificates.js'));
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.renewed, []);
  assert.equal(new X509Certificate(readFileSync(path)).serialNumber, before.serialNumber);
  const result = JSON.parse(run('scripts/renew-host-certificates.js', ['--apply', '--force']));
  assert.deepEqual(result.recreateContainers, ['broker', 'worker']);
  assert.deepEqual(result.renewed, ['server', 'worker']);
  const after = new X509Certificate(readFileSync(path));
  assert.notEqual(after.serialNumber, before.serialNumber);
  assert.equal(after.checkIP('192.168.15.10'), '192.168.15.10');
  assert.equal(after.checkIP('192.168.15.11'), '192.168.15.11');
  assert.deepEqual(readFileSync(join(dir, 'server.key')), key);
  assert.equal(after.publicKey.equals(before.publicKey), true);
});
