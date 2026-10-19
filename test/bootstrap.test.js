import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { setup } from './helpers.js';
import { initialize, configuration } from '../server/bootstrap.js';
import { Store } from '../server/store.js';

test('quoted AD passwords in .env preserve special characters and override the file', () => {
  const password = '  test # $ = "quoted" \\ literal  ';
  const env = parseEnv(
    `WG_LDAP_PASSWORD='${password}'\nWG_LDAP_PASSWORD_FILE=missing-file-must-not-be-opened\n`,
  );
  assert.equal(configuration(env).ldapPassword, password);
});

test('an empty or absent inline AD password falls back to the password file', (t) => {
  const { store } = setup(t);
  const passwordFile = join(store.root, 'ad-test-password');
  writeFileSync(passwordFile, '  file-test # $  \r\n', { mode: 0o600 });
  assert.equal(configuration({ WG_LDAP_PASSWORD_FILE: passwordFile }).ldapPassword, '  file-test # $  ');
  assert.equal(
    configuration({ WG_LDAP_PASSWORD: '', WG_LDAP_PASSWORD_FILE: passwordFile }).ldapPassword,
    '  file-test # $  ',
  );
  assert.equal(configuration({ WG_LDAP_PASSWORD: '' }).ldapPassword, '');
});

const settings = (defaults) => ({
  ...defaults,
  directory: {
    urls: ['ldaps://dc.example.test:636/'],
    baseDn: 'DC=example,DC=test',
    bindDn: 'CN=Service,DC=example,DC=test',
    groups: [{ dn: 'CN=Gateway Admins,DC=example,DC=test', role: 'administrator' }],
  },
});

test('unused development setup follows corrected AD values from .env and preserves other settings', (t) => {
  const { store, config } = setup(t, 'development'),
    before = store.current('gateway');
  const corrected = settings(config.defaults);
  initialize(store, { ...corrected, confirmationSeconds: 60 });
  assert.deepEqual(store.current('gateway').value.directory, corrected.directory);
  assert.equal(store.current('gateway').value.confirmationSeconds, before.value.confirmationSeconds);
  assert.equal(store.current('gateway').revision, 1);
  assert.equal(
    store.events().filter((event) => event.action === 'development_directory_initialized').length,
    1,
  );
});

test('a successful login locks the development directory bootstrap', (t) => {
  const { store, config } = setup(t, 'development'),
    before = store.current('gateway');
  store.audit('test-user', 'login');
  initialize(store, settings(config.defaults));
  assert.deepEqual(store.current('gateway'), before);
});

test('a gateway draft or newer revision locks the development directory bootstrap', (t) => {
  const { store, config } = setup(t, 'development'),
    before = store.current('gateway');
  const change = store.propose(
    'gateway',
    { ...before.value, confirmationSeconds: 60 },
    before.revision,
    'user',
  );
  initialize(store, settings(config.defaults));
  assert.deepEqual(store.current('gateway'), before);
  store.begin(change.id, 'user');
  store.health(change.id, true, {});
  store.confirm(change.id, 'user');
  const confirmed = store.current('gateway');
  initialize(store, settings(config.defaults));
  assert.deepEqual(store.current('gateway'), confirmed);
});

test('existing production directory is never replaced by .env bootstrap synchronization', (t) => {
  const { store, now } = setup(t);
  const prod = new Store({ root: join(store.root, 'production'), environment: 'production', clock: now });
  try {
    const defaults = configuration({ WG_ENVIRONMENT: 'production' }).defaults;
    initialize(prod, defaults);
    const before = prod.current('gateway');
    initialize(prod, settings(defaults));
    assert.deepEqual(prod.current('gateway'), before);
  } finally {
    prod.close();
  }
});
