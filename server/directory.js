import { Client } from 'ldapts';
import { readFileSync } from 'node:fs';
import { Rejected } from './store.js';

const escapeFilter = (v) =>
  v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const one = (v) => (Array.isArray(v) ? v[0] : v);
export function directoryFailure(error, url, stage) {
  const target = new URL(url),
    code =
      typeof error?.code === 'number' && Number.isInteger(error.code) && error.code >= 0 && error.code <= 255
        ? `LDAP_${error.code}`
        : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
          ? error.code
          : error?.message === 'Connection timeout'
            ? 'ETIMEDOUT'
            : 'LDAP_ERROR';
  const result = {
    event: 'directory_connection_failed',
    host: target.hostname,
    port: Number(target.port || 636),
    stage,
    code,
  };
  const subcode =
    error?.code === 49 && /\bdata\s+([0-9a-f]{3,4})(?:[,\s]|$)/i.exec(error.message || '')?.[1].toLowerCase();
  if (subcode && ['525', '52e', '530', '531', '532', '533', '701', '773', '775'].includes(subcode))
    result.adSubcode = subcode;
  return result;
}
export function sidString(value) {
  value = one(value);
  if (typeof value === 'string') return value;
  if (!Buffer.isBuffer(value) || value.length < 8 || value.length !== 8 + value[1] * 4)
    throw new Error('Ugyldig AD-SID');
  let authority = 0n;
  for (let i = 2; i < 8; i++) authority = authority * 256n + BigInt(value[i]);
  return `S-${value[0]}-${authority}${Array.from({ length: value[1] }, (_, i) => `-${value.readUInt32LE(8 + 4 * i)}`).join('')}`;
}
export class Directory {
  constructor({
    password,
    caFile,
    clientFactory = (options) => new Client(options),
    logger = (entry) => console.error(JSON.stringify(entry)),
  }) {
    this.password = password;
    this.caFile = caFile;
    this.clientFactory = clientFactory;
    this.logger = logger;
  }
  async withClient(settings, operation) {
    if (!settings.urls.length || !settings.baseDn || !settings.bindDn || !this.password)
      throw new Rejected('AD er ikke konfigurert', 503);
    let ca;
    try {
      ca = this.caFile ? readFileSync(this.caFile) : undefined;
    } catch {
      throw new Rejected('AD-CA mangler eller kan ikke leses. Legg inn riktig AD-CA separat.', 503);
    }
    for (const [index, url] of settings.urls.entries()) {
      const u = new URL(url);
      if (u.protocol !== 'ldaps:') throw new Error('Ukryptert LDAP er deaktivert');
      const client = this.clientFactory({
        url,
        timeout: 7000,
        connectTimeout: 7000,
        tlsOptions: {
          minVersion: 'TLSv1.2',
          rejectUnauthorized: true,
          servername: u.hostname,
          ...(ca ? { ca } : {}),
        },
      });
      let stage = 'service_bind';
      try {
        await client.bind(settings.bindDn, this.password);
        stage = 'directory_operation';
        return await operation(client);
      } catch (error) {
        if (!(error instanceof Rejected)) this.logger(directoryFailure(error, url, stage));
        // Invalid service credentials apply across DCs; do not retry them on
        // every controller and add unnecessary failed logins to the account.
        if (error instanceof Rejected || error.code === 49 || index === settings.urls.length - 1)
          throw error instanceof Rejected
            ? error
            : new Rejected('AD er utilgjengelig eller avviser sikker tilkobling', 503);
      } finally {
        await client.unbind().catch(() => {});
      }
    }
  }
  async roles(client, userDn, settings) {
    const roles = new Set(),
      groups = [];
    for (const binding of settings.groups) {
      const { searchEntries } = await client.search(binding.dn, {
        scope: 'base',
        filter: `(&(objectClass=group)(member:1.2.840.113556.1.4.1941:=${escapeFilter(userDn)}))`,
        attributes: ['objectSid'],
      });
      if (searchEntries.length !== 1) continue;
      const sid = sidString(searchEntries[0].objectSid);
      if (binding.sid && binding.sid !== sid)
        throw new Rejected('AD-gruppen har en annen identitet enn konfigurert', 403);
      roles.add(binding.role);
      groups.push(sid);
    }
    if (!roles.size) throw new Rejected('Innlogging avvist', 401);
    return { roles: [...roles], groups };
  }
  async authenticate(username, password, settings) {
    if (
      typeof username !== 'string' ||
      !username.trim() ||
      username.length > 254 ||
      typeof password !== 'string' ||
      !password ||
      password.length > 1024
    )
      throw new Rejected('Innlogging avvist', 401);
    return this.withClient(settings, async (client) => {
      const value = escapeFilter(username.trim());
      const { searchEntries } = await client.search(settings.baseDn, {
        scope: 'sub',
        filter: `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=${value})(userPrincipalName=${value})))`,
        attributes: ['dn', 'objectSid', 'displayName', 'sAMAccountName', 'userAccountControl'],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) throw new Rejected('Innlogging avvist', 401);
      const user = searchEntries[0];
      if (Number(one(user.userAccountControl)) & 2) throw new Rejected('Innlogging avvist', 401);
      try {
        await client.bind(user.dn, password);
      } catch {
        throw new Rejected('Innlogging avvist', 401);
      }
      await client.bind(settings.bindDn, this.password);
      return {
        sid: sidString(user.objectSid),
        dn: user.dn,
        username: String(one(user.sAMAccountName)),
        name: String(one(user.displayName) || username),
        ...(await this.roles(client, user.dn, settings)),
      };
    });
  }
  async refresh(principal, settings) {
    return this.withClient(settings, async (client) => {
      const { searchEntries } = await client.search(principal.dn, {
        scope: 'base',
        filter: '(objectClass=user)',
        attributes: ['objectSid', 'userAccountControl'],
      });
      if (
        searchEntries.length !== 1 ||
        Number(one(searchEntries[0].userAccountControl)) & 2 ||
        sidString(searchEntries[0].objectSid) !== principal.sid
      )
        throw new Rejected('Sesjonen er tilbakekalt', 401);
      return { ...principal, ...(await this.roles(client, principal.dn, settings)) };
    });
  }
  async probe(principal, settings) {
    const current = await this.refresh(principal, settings);
    if (!current.roles.includes('administrator'))
      throw new Rejected('Kandidaten gir ikke administratoren tilgang', 409);
    return { directory: 'ok', administrator: true };
  }
}
