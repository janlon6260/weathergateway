import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hash, Rejected } from './store.js';
import { id } from './schema.js';

export const clientSettings = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
    enabled: z.boolean().default(true),
    allStations: z.boolean().default(true),
    stationIds: z.array(id).max(100).default([]),
    expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
    origins: z
      .array(
        z
          .string()
          .url()
          .max(2048)
          .refine((v) => {
            try {
              const u = new URL(v);
              return !u.username && !u.password && u.origin === v && u.protocol === 'https:';
            } catch {
              return false;
            }
          }, 'Bruk eksakt HTTPS-opprinnelse uten sti'),
      )
      .max(20)
      .default([]),
    maxConnections: z.number().int().min(1).max(20).default(3),
  })
  .strict()
  .refine((v) => v.allStations || v.stationIds.length > 0, 'Velg minst én stasjon');
const publicPolicy = z.object({
  format: z.literal('wg-access-1'),
  environment: z.string(),
  generatedAt: z.number().int().nonnegative(),
  leaseUntil: z.number().int().nonnegative(),
  clients: z
    .array(
      z.object({
        id,
        revision: z.number().int().positive(),
        tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
        allStations: z.boolean(),
        stationIds: z.array(id).max(100),
        expiresAt: z.iso.datetime({ offset: true }).nullable(),
        origins: z.array(z.string()).max(20),
        maxConnections: z.number().int().min(1).max(20),
      }),
    )
    .max(200),
});
export class ApiClients {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.path =
      config.publicAccessFile ||
      join(
        config.certificateRoot || store.safe('system', 'certificates'),
        'roles',
        'public',
        'socket-clients.json',
      );
  }
  rows() {
    return this.store.db
      .prepare('SELECT * FROM api_clients')
      .all()
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  list() {
    return this.rows()
      .map(({ id, revision, payload: p }) => ({
        id,
        revision,
        ...p,
        tokenHash: undefined,
        status: !p.enabled
          ? 'revoked'
          : p.expiresAt && Date.parse(p.expiresAt) <= this.store.clock()
            ? 'expired'
            : 'approved',
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  validate(input) {
    const value = clientSettings.parse(input);
    for (const key of value.stationIds) this.store.current(`station:${key}`);
    if (value.enabled && value.expiresAt && Date.parse(value.expiresAt) <= this.store.clock())
      throw new Rejected('Utløpstiden må være i fremtiden', 400);
    return value;
  }
  create(input, actor) {
    input = z.record(z.string(), z.unknown()).parse(input);
    const { adoptLegacyToken = false, ...settings } = input;
    z.boolean().parse(adoptLegacyToken);
    const value = this.validate(settings);
    let token;
    if (adoptLegacyToken) {
      try {
        token =
          this.config.publicToken ||
          readFileSync(
            this.config.publicTokenFile || join(this.config.certificateRoot, 'read-token'),
            'utf8',
          ).trim();
      } catch {
        throw new Rejected('Eksisterende lesetoken er ikke opprettet', 409);
      }
      if (token.length < 32) throw new Rejected('Eksisterende lesetoken er ugyldig', 409);
    } else token = `wg_${randomBytes(32).toString('base64url')}`;
    const clientId = randomUUID(),
      now = this.store.clock();
    this.store.db
      .transaction(() => {
        const rows = this.rows();
        if (rows.length >= 200) throw new Rejected('Maksimalt 200 tilkoblinger kan registreres');
        if (rows.some((r) => r.payload.tokenHash === hash(token)))
          throw new Rejected('Dette tokenet har allerede en registrert godkjenning');
        this.store.db.prepare('INSERT INTO api_clients VALUES (?,?,?)').run(
          clientId,
          1,
          JSON.stringify({
            ...value,
            createdAt: now,
            updatedAt: now,
            approvedBy: actor,
            tokenHash: hash(token),
            tokenHint: adoptLegacyToken ? 'Eksisterende lesetoken' : token.slice(0, 9) + '…',
            legacy: adoptLegacyToken,
          }),
        );
        this.store.audit(actor, 'api_client_approved', {
          id: clientId,
          name: value.name,
          expiresAt: value.expiresAt,
          allStations: value.allStations,
          stationIds: value.stationIds,
        });
      })
      .immediate();
    this.publish();
    return { client: this.list().find((c) => c.id === clientId), token: adoptLegacyToken ? null : token };
  }
  update(clientId, revision, input, actor) {
    id.parse(clientId);
    const value = this.validate(input);
    this.store.db
      .transaction(() => {
        const row = this.rows().find((r) => r.id === clientId);
        if (!row) throw new Rejected('Tilkoblingen finnes ikke', 404);
        if (row.revision !== revision) throw new Rejected('Tilkoblingen er endret av en annen bruker');
        this.store.db
          .prepare('UPDATE api_clients SET payload=?,revision=revision+1 WHERE id=?')
          .run(
            JSON.stringify({ ...row.payload, ...value, updatedAt: this.store.clock(), approvedBy: actor }),
            clientId,
          );
        this.store.audit(actor, value.enabled ? 'api_client_updated' : 'api_client_revoked', {
          id: clientId,
          expiresAt: value.expiresAt,
          allStations: value.allStations,
          stationIds: value.stationIds,
        });
      })
      .immediate();
    this.publish();
    return this.list().find((c) => c.id === clientId);
  }
  rotate(clientId, revision, actor) {
    id.parse(clientId);
    const token = `wg_${randomBytes(32).toString('base64url')}`;
    this.store.db
      .transaction(() => {
        const row = this.rows().find((r) => r.id === clientId);
        if (!row) throw new Rejected('Tilkoblingen finnes ikke', 404);
        if (row.revision !== revision) throw new Rejected('Tilkoblingen er endret av en annen bruker');
        this.store.db.prepare('UPDATE api_clients SET payload=?,revision=revision+1 WHERE id=?').run(
          JSON.stringify({
            ...row.payload,
            tokenHash: hash(token),
            tokenHint: token.slice(0, 9) + '…',
            legacy: false,
            updatedAt: this.store.clock(),
          }),
          clientId,
        );
        this.store.audit(actor, 'api_client_token_rotated', { id: clientId });
      })
      .immediate();
    this.publish();
    return { client: this.list().find((c) => c.id === clientId), token };
  }
  publish() {
    const now = this.store.clock(),
      clients = this.rows()
        .filter((r) => r.payload.enabled && (!r.payload.expiresAt || Date.parse(r.payload.expiresAt) > now))
        .map(({ id, revision, payload: p }) => ({
          id,
          revision,
          tokenHash: p.tokenHash,
          allStations: p.allStations,
          stationIds: p.stationIds,
          expiresAt: p.expiresAt,
          origins: p.origins,
          maxConnections: p.maxConnections,
        }));
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o750 });
    writeFileSync(
      this.path + '.tmp',
      JSON.stringify({
        format: 'wg-access-1',
        environment: this.store.environment,
        generatedAt: now,
        leaseUntil: now + 15000,
        clients,
      }),
      { mode: 0o640, flush: true },
    );
    renameSync(this.path + '.tmp', this.path);
  }
}
export class PublicAccess {
  constructor(store, config) {
    this.store = store;
    this.path =
      config.publicAccessFile ||
      (config.publicTokenFile ? join(dirname(config.publicTokenFile), 'socket-clients.json') : null);
  }
  policy() {
    try {
      const p = publicPolicy.parse(JSON.parse(readFileSync(this.path, 'utf8'))),
        now = this.store.clock();
      if (
        p.format !== 'wg-access-1' ||
        p.environment !== this.store.environment ||
        p.generatedAt > now + 5000 ||
        p.leaseUntil <= now ||
        p.leaseUntil - p.generatedAt > 15000 ||
        !Array.isArray(p.clients)
      )
        return null;
      return p;
    } catch {
      return null;
    }
  }
  authorize(token, origin) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) return null;
    const p = this.policy();
    if (!p) return null;
    const client = p.clients.find((c) => c.tokenHash === hash(token));
    if (
      !client ||
      (client.expiresAt && Date.parse(client.expiresAt) <= this.store.clock()) ||
      (origin && !client.origins.includes(origin))
    )
      return null;
    return client;
  }
  permitted(client) {
    return this.store
      .stationList()
      .map((s) => this.store.confirmedValue(s.scope))
      .filter(
        (s) => s.enabled && s.model !== 'Netatmo' && (client.allStations || client.stationIds.includes(s.id)),
      );
  }
  select(client, selectors = []) {
    const names = z.array(z.string().min(1).max(100)).max(100).parse(selectors),
      allowed = this.permitted(client);
    if (!names.length) return allowed;
    const result = [];
    for (const name of names) {
      const key = name.normalize('NFC').toLocaleLowerCase('nb-NO'),
        matches = allowed.filter((s) =>
          [s.id, s.key, s.name].some((v) => v.normalize('NFC').toLocaleLowerCase('nb-NO') === key),
        );
      if (matches.length !== 1) throw new Rejected('Stasjonen er ukjent eller ikke godkjent', 403);
      if (!result.some((s) => s.id === matches[0].id)) result.push(matches[0]);
    }
    return result;
  }
  filter(client, object, selectors = []) {
    const keys = new Set(this.select(client, selectors).map((s) => s.key));
    return Object.fromEntries(Object.entries(object).filter(([key]) => keys.has(key)));
  }
}
