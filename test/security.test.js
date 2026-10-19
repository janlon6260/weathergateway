import test from 'node:test';
import assert from 'node:assert/strict';
import { privateNetworks } from '../server/auth.js';
import { sidString, Directory, directoryFailure } from '../server/directory.js';
import { configuration } from '../server/bootstrap.js';

test('adminnett kan ikke utvides til internett; IPv4/IPv6 og mapped IPv4', () => {
  assert.throws(() => privateNetworks(['0.0.0.0/0']));
  assert.throws(() => privateNetworks(['10.0.0.0/0']));
  assert.throws(() => privateNetworks(['172.16.0.0/8']));
  const allow = privateNetworks(['10.0.0.0/8', '127.0.0.0/8', '::1/128']);
  assert.equal(allow('8.8.8.8'), false);
  assert.equal(allow('::ffff:127.0.0.1'), true);
  assert.equal(allow('10.0.0.5'), true);
  assert.equal(allow('::1'), true);
});
test('AD-SID dekodes med korrekt byteorden', () => {
  const data = Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 232, 3, 0, 0]);
  assert.equal(sidString(data), 'S-1-5-21-1000');
  assert.throws(() => sidString(Buffer.alloc(2)));
});

test('private CIDRs accept surrounding whitespace without widening the permitted networks', () => {
  const allow = privateNetworks([' 172.29.80.0/24 ', '\t127.0.0.0/8\r\n', ' ::1/128 ']);
  assert.equal(allow('172.29.80.1'), true);
  assert.equal(allow('172.29.80.254'), true);
  assert.equal(allow('172.29.81.1'), false);
  assert.equal(allow('172.32.0.1'), false);
  assert.equal(allow('::ffff:172.29.80.5'), true);
  assert.equal(allow('::1'), true);
  for (const cidr of [
    ' 0.0.0.0/0 ',
    '172.29.80.0/8',
    '172.29.80.0/24/0',
    '172.29.80.0/',
    '172.29.80.0/33',
    '10.0.0.0/0x18',
    '::1/129',
  ])
    assert.throws(() => privateNetworks([cidr]));
});

test('comma-separated .env lists trim spaces and ignore empty entries', () => {
  const config = configuration({
    WG_ADMIN_CIDRS: '127.0.0.0/8, ::1/128, 172.29.80.0/24, ',
    WG_TRUSTED_PROXIES: ' 127.0.0.1/32, ::1/128,',
    WG_LDAP_URLS: ' ldaps://dc1.test:636/, ldaps://dc2.test:636/, ',
  });
  assert.deepEqual(config.adminCidrs, ['127.0.0.0/8', '::1/128', '172.29.80.0/24']);
  assert.deepEqual(config.trustedProxies, ['127.0.0.1/32', '::1/128']);
  assert.deepEqual(config.defaults.directory.urls, ['ldaps://dc1.test:636/', 'ldaps://dc2.test:636/']);
});
test('LDAPS verifiserer CA/servernavn og escaper katalogfilter', async () => {
  const options = [],
    filters = [];
  const client = {
    async bind() {},
    async unbind() {},
    async search(dn, query) {
      filters.push(query.filter);
      if (dn === 'DC=test')
        return {
          searchEntries: [
            {
              dn: 'CN=Test,DC=test',
              objectSid: 'S-1-5-21-1',
              userAccountControl: '512',
              sAMAccountName: 'test',
            },
          ],
        };
      return { searchEntries: [{ objectSid: 'S-1-5-21-2' }] };
    },
  };
  const provider = new Directory({
    password: 'service-test',
    clientFactory: (o) => {
      options.push(o);
      return client;
    },
  });
  await provider.authenticate('test*)(cn=*)', 'user-test', {
    urls: ['ldaps://dc.test/'],
    baseDn: 'DC=test',
    bindDn: 'CN=Bind',
    groups: [{ dn: 'CN=WG Admin,DC=test', role: 'administrator' }],
  });
  assert.equal(options[0].tlsOptions.rejectUnauthorized, true);
  assert.equal(options[0].tlsOptions.servername, 'dc.test');
  assert.equal(filters[0].includes('test*)(cn=*)'), false);
  assert.equal(filters[0].includes('\\2a\\29\\28'), true);
});
test('tomt AD-passord forsøkes ikke bundet', async () => {
  const provider = new Directory({
    password: 'test',
    clientFactory: () => {
      throw new Error('Should not connect');
    },
  });
  await assert.rejects(provider.authenticate('user', '', {}), { status: 401 });
});

test('LDAPS failure logs a safe reason code without leaking credentials or certificate contents', async () => {
  const logs = [],
    error = Object.assign(new Error('sensitive-test-password CN=Secret -----BEGIN CERTIFICATE-----'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
  const provider = new Directory({
    password: 'sensitive-test-password',
    logger: (entry) => logs.push(entry),
    clientFactory: () => ({
      async bind() {
        throw error;
      },
      async unbind() {},
    }),
  });
  await assert.rejects(
    provider.withClient({ urls: ['ldaps://dc.test:636/'], baseDn: 'DC=test', bindDn: 'CN=Secret' }, () => {}),
    {
      status: 503,
      message: 'AD er utilgjengelig eller avviser sikker tilkobling',
    },
  );
  assert.deepEqual(logs, [
    {
      event: 'directory_connection_failed',
      host: 'dc.test',
      port: 636,
      stage: 'service_bind',
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    },
  ]);
  assert.equal(JSON.stringify(logs).includes('sensitive-test-password'), false);
  assert.equal(JSON.stringify(logs).includes('CN=Secret'), false);
  assert.equal(directoryFailure({ code: 49 }, 'ldaps://dc.test/', 'service_bind').code, 'LDAP_49');
  const diagnostic = directoryFailure(
    { code: 49, message: 'LdapErr: private details, data 52e, v1234' },
    'ldaps://dc.test/',
    'service_bind',
  );
  assert.equal(diagnostic.adSubcode, '52e');
  assert.equal(JSON.stringify(diagnostic).includes('private details'), false);
  assert.equal(
    directoryFailure(
      { code: 'secret-password', message: 'secret-password' },
      'ldaps://dc.test/',
      'service_bind',
    ).code,
    'LDAP_ERROR',
  );
});

test('invalid service credentials are not retried against other domain controllers', async () => {
  let clients = 0;
  const provider = new Directory({
    password: 'test-password',
    logger: () => {},
    clientFactory: () => {
      clients++;
      return {
        async bind() {
          throw Object.assign(new Error('private AD diagnostic'), { code: 49 });
        },
        async unbind() {},
      };
    },
  });
  await assert.rejects(
    provider.withClient(
      { urls: ['ldaps://dc1.test/', 'ldaps://dc2.test/'], baseDn: 'DC=test', bindDn: 'CN=Service' },
      () => {},
    ),
    { status: 503 },
  );
  assert.equal(clients, 1);
});
