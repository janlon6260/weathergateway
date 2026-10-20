import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setup } from './helpers.js';

test('non-root preparation uses UID 70001/GID 70007 and never attempts privileged ownership changes', (t) => {
  const { store } = setup(t),
    data = join(store.root, 'nonroot-data'),
    certificates = join(store.root, 'nonroot-certificates');
  // Exercise POSIX ownership rules on every platform, including Windows QA.
  const code = `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const stat = fs.lstatSync;
    fs.lstatSync = (...args) => { const value = stat(...args); value.uid = 70001; value.gid = 70007; return value; };
    fs.chownSync = () => { throw Error('Privileged ownership change attempted'); };
    syncBuiltinESMExports();
    Object.defineProperty(process,'platform',{value:'linux'});
    process.getuid = () => 70001; process.getgid = () => 70007;
    await import('./scripts/prepare-container.js');
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      WG_ENVIRONMENT: 'development',
      WG_DATA_ROOT: data,
      WG_CERTIFICATE_ROOT: certificates,
    },
  });
  const report = JSON.parse(output);
  assert.equal(report.uid, 70001);
  assert.equal(report.gid, 70007);
  assert.equal(existsSync(join(data, 'system/mqtt/data')), true);
  assert.equal(existsSync(join(certificates, 'roles/broker')), true);
  assert.equal(existsSync(join(certificates, 'client-ca.key')), false);
});

test(
  'actual control process starts from empty certificate and data directories, without an AD CA or password file',
  { timeout: 15000 },
  async (t) => {
    const { store } = setup(t),
      data = join(store.root, 'empty-data'),
      certificates = join(store.root, 'empty-certificates');
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('WG_')));
    const processUnderTest = spawn(process.execPath, ['server/index.js'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        WG_ENVIRONMENT: 'development',
        WG_ROLE: 'control',
        WG_DATA_ROOT: data,
        WG_CERTIFICATE_ROOT: certificates,
        WG_ALLOW_LOCAL_HTTP: 'true',
        WG_BIND: '127.0.0.1',
        PORT: String(port),
        WG_LDAP_PASSWORD_FILE: join(certificates, 'ldap-password'),
        WG_LDAP_CA_FILE: join(certificates, 'ad-ca.pem'),
      },
    });
    let output = '';
    for (const stream of [processUnderTest.stdout, processUnderTest.stderr])
      stream.on('data', (data) => (output = (output + data).slice(-4000)));
    try {
      let response;
      for (let i = 0; i < 80; i++) {
        assert.equal(processUnderTest.exitCode, null, output);
        try {
          response = await fetch(`http://127.0.0.1:${port}/health/live`);
          if (response.ok) break;
        } catch {
          /* startup */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(response?.status, 200, output);
      assert.equal(existsSync(join(certificates, 'client-ca.key')), false);
      assert.equal(existsSync(join(certificates, 'server.pem')), false);
      assert.equal(existsSync(join(data, 'system/mqtt/mosquitto.conf')), true);
      assert.equal(existsSync(join(data, 'public/system/gateway.sqlite3')), true);
      const session = await fetch(`http://127.0.0.1:${port}/api/session`);
      assert.equal(session.status, 401);
    } finally {
      if (processUnderTest.exitCode === null) {
        const exited = once(processUnderTest, 'exit');
        processUnderTest.kill('SIGKILL');
        await exited;
      }
    }
  },
);
