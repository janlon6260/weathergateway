import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parse, serialize } from 'cookie';
import { BlockList, isIP } from 'node:net';
import { hash, Rejected } from './store.js';

export const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function privateNetworks(cidrs) {
  const list = new BlockList();
  const ranges = [
    ['127.0.0.0', 8, 'ipv4'],
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['::1', 128, 'ipv6'],
    ['fc00::', 7, 'ipv6'],
    ['fe80::', 10, 'ipv6'],
  ];
  for (const rawCidr of cidrs) {
    const cidr = rawCidr.trim(),
      parts = cidr.split('/').map((v) => v.trim()),
      [address, bitsText] = parts,
      family = isIP(address) === 4 ? 'ipv4' : 'ipv6',
      bits = Number(bitsText ?? (family === 'ipv4' ? 32 : 128));
    if (
      parts.length > 2 ||
      (bitsText !== undefined && !/^\d+$/.test(bitsText)) ||
      !isIP(address) ||
      !Number.isInteger(bits) ||
      bits > (family === 'ipv4' ? 32 : 128) ||
      !ranges.some(([a, b, f]) => {
        const block = new BlockList();
        block.addSubnet(a, b, f);
        return family === f && bits >= b && block.check(address, f);
      })
    )
      throw new Error(`Adminnett må være et avgrenset privat nett: ${JSON.stringify(rawCidr)}`);
    list.addSubnet(address, bits, family);
  }
  return (address) => {
    address = address?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
    return isIP(address) && list.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  };
}
export class Sessions {
  constructor(store, directory, { secure = true } = {}) {
    this.store = store;
    this.directory = directory;
    this.secure = secure;
    this.cookieName = `${secure ? '__Host-' : ''}wg-${store.environment}`;
  }
  cookie(token, maxAge) {
    return serialize(this.cookieName, token, {
      secure: this.secure,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
  }
  async login(username, password) {
    const settings = this.store.current('gateway').value;
    const principal = await this.directory.authenticate(username, password, settings.directory);
    const token = randomBytes(32).toString('base64url'),
      csrf = randomBytes(32).toString('base64url'),
      now = this.store.clock();
    this.store.db
      .prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)')
      .run(hash(token), csrf, JSON.stringify(principal), now, now, now);
    this.store.audit(principal.sid, 'login');
    return { principal, token, csrf };
  }
  async read(req, forceRefresh = false, { touch = true } = {}) {
    const token = parse(req.headers.cookie || '')[this.cookieName];
    if (!token) throw new Rejected('Innlogging kreves', 401);
    const session = this.store.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hash(token));
    const now = this.store.clock(),
      settings = this.store.current('gateway').value;
    if (
      !session ||
      now < session.last_at ||
      now - session.last_at > settings.sessionIdleMinutes * 60000 ||
      now - session.created_at > settings.sessionAbsoluteHours * 3600000
    ) {
      if (session) this.destroy(token);
      throw new Rejected('Sesjonen er utløpt', 401);
    }
    let principal = JSON.parse(session.principal);
    if (forceRefresh || now - session.verified_at >= 60000) {
      try {
        principal = await this.directory.refresh(principal, settings.directory);
      } catch (error) {
        this.destroy(token);
        throw error;
      }
      session.verified_at = now;
    }
    this.store.db
      .prepare('UPDATE sessions SET last_at=?,verified_at=?,principal=? WHERE token_hash=?')
      .run(touch ? now : session.last_at, session.verified_at, JSON.stringify(principal), hash(token));
    return { principal, csrf: session.csrf, token };
  }
  destroy(token) {
    this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  }
}
export function requireRole(principal, ...roles) {
  if (!principal.roles.some((r) => roles.includes(r) || r === 'administrator'))
    throw new Rejected('Du har ikke tilgang til denne handlingen', 403);
}
