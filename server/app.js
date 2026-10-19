import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';
import { resolve, join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Rejected, hash } from './store.js';
import { Sessions, requireRole, privateNetworks, equal } from './auth.js';
import { stationSchema, deviceSchema, defaultDevice, id } from './schema.js';
import { snapshot, latest, history, periodReport } from './observations.js';
import { astronomy } from './astronomy.js';
import { attachLegacySockets } from './legacy-sockets.js';
import { storageHealth } from './maintenance.js';
import { startBackup, listBackups } from './backups.js';

const safeGatewayFields = [
  'confirmationSeconds',
  'sessionIdleMinutes',
  'sessionAbsoluteHours',
  'retentionDays',
  'warningSeconds',
  'downSeconds',
];
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
function baseApp(config) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustedProxies);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.secureCookies ? [] : null,
        },
      },
      hsts: config.secureCookies,
    }),
  );
  app.use(express.json({ limit: '256kb', strict: true }));
  app.get('/health/live', (_req, res) =>
    res.json({ status: 'ok', role: config.role, environment: config.environment }),
  );
  return app;
}
function errors(app) {
  app.use((_req, res) => res.status(404).json({ error: 'Ruten finnes ikke' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: 'Ugyldige verdier',
        fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    if (error instanceof Rejected) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ugyldig JSON' });
    if (error.type === 'entity.too.large')
      return res.status(413).json({ error: 'Forespørselen er for stor' });
    if (error.status === 404) return res.status(404).json({ error: 'Filen finnes ikke ennå' });
    console.error(JSON.stringify({ event: 'request_failed', type: error.code || error.name }));
    res.status(500).json({ error: 'Handlingen kunne ikke fullføres' });
  });
  return app;
}
export async function probe(store, directory, change, principal) {
  if (change.scope.startsWith('device:')) {
    if (!change.health || store.clock() - change.health.at > 30000)
      throw new Rejected('Venter på bekreftelse og telemetri fra enheten');
    return change.health;
  }
  accessSync(store.safe('system'), constants.R_OK | constants.W_OK);
  const report = { storage: 'ok', schema: 'ok' };
  if (change.scope === 'gateway')
    Object.assign(report, await directory.probe(principal, change.candidate.directory));
  return report;
}
export function controlApp({ store, config, directory, certificates }) {
  const app = baseApp(config),
    sessions = new Sessions(store, directory, { secure: config.secureCookies }),
    allowedNetwork = privateNetworks(config.adminCidrs),
    streams = new Map();
  app.use((req, res, next) =>
    allowedNetwork(req.ip)
      ? next()
      : res.status(403).json({ error: 'Administrasjon krever internnett eller VPN' }),
  );
  app.use(
    '/api',
    rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }),
  );
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origins = new Set([new URL(store.current('gateway').value.adminOrigin).origin]);
    for (const c of store
      .changes()
      .filter((c) => c.scope === 'gateway' && ['testing', 'confirming'].includes(c.state)))
      origins.add(new URL(c.before.adminOrigin).origin);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origins.has(req.headers.origin))
      return res.status(403).json({ error: 'Ugyldig forespørselsopprinnelse' });
    next();
  });
  app.post(
    '/api/login',
    rateLimit({ windowMs: 900000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }),
    asyncHandler(async (req, res) => {
      const { username, password } = z
        .object({ username: z.string().max(254), password: z.string().min(1).max(1024) })
        .strict()
        .parse(req.body);
      const result = await sessions.login(username, password);
      res.set('Set-Cookie', sessions.cookie(result.token, 86400));
      res.json({ principal: result.principal, csrf: result.csrf, environment: store.environment });
    }),
  );
  app.use(
    '/api',
    asyncHandler(async (req, _res, next) => {
      req.session = await sessions.read(req, !['GET', 'HEAD'].includes(req.method), {
        touch: !['/state', '/live', '/live/events'].includes(req.path),
      });
      if (!['GET', 'HEAD'].includes(req.method) && !equal(req.headers['x-csrf-token'], req.session.csrf))
        throw new Rejected('Ugyldig sikkerhetstoken', 403);
      next();
    }),
  );
  const permission =
    (...roles) =>
    (req, _res, next) => {
      try {
        requireRole(req.session.principal, ...roles);
        next();
      } catch (e) {
        next(e);
      }
    };
  app.get('/api/session', (req, res) =>
    res.json({ principal: req.session.principal, csrf: req.session.csrf, environment: store.environment }),
  );
  app.post('/api/logout', (req, res) => {
    sessions.destroy(req.session.token);
    res.set('Set-Cookie', sessions.cookie('', 0)).json({ ok: true });
  });
  app.get('/api/state', (req, res) => {
    const admin = req.session.principal.roles.includes('administrator');
    res.json({
      principal: req.session.principal,
      environment: store.environment,
      gateway: admin
        ? store.current('gateway')
        : {
            value: {
              adminOrigin: store.current('gateway').value.adminOrigin,
              developmentOrigin: store.current('gateway').value.developmentOrigin,
              productionOrigin: store.current('gateway').value.productionOrigin,
              ...Object.fromEntries(safeGatewayFields.map((k) => [k, store.current('gateway').value[k]])),
            },
          },
      stations: store.stationList(),
      devices:
        admin || req.session.principal.roles.includes('operator')
          ? store.configurations('device:').map((device) => {
              const observation = latest(store, device.value.stationId);
              return {
                ...device,
                telemetry: observation
                  ? {
                      observedAt: observation.observedAt,
                      sensorContact: observation.sensorContact,
                      measurementTimes: observation.measurementTimes,
                      iss: observation.iss,
                      channel: observation.source?.channel,
                      rssiDbm: observation.source?.rssiDbm,
                      quality: observation.quality,
                    }
                  : null,
              };
            })
          : [],
      changes:
        admin || req.session.principal.roles.includes('operator')
          ? store.changes().filter((c) => admin || c.scope !== 'gateway')
          : [],
      commands: admin || req.session.principal.roles.includes('operator') ? store.commandList() : [],
      now: store.clock(),
    });
  });
  app.get('/api/live', (_req, res) => res.json(snapshot(store)));
  app.get('/api/health', permission('administrator'), (_req, res) => {
    res.json({
      environment: store.environment,
      storage: storageHealth(store),
      database: store.db.prepare('SELECT 1 AS ok').get().ok === 1 ? 'ok' : 'error',
      certificatesExpiring: store.db
        .prepare('SELECT station_id,expires_at FROM certificates WHERE revoked_at IS NULL AND expires_at<?')
        .all(store.clock() + 14 * 86400000),
    });
  });
  app.get('/api/backups', permission('administrator'), (_req, res) => res.json(listBackups(store)));
  app.post('/api/backups', permission('administrator'), (req, res) =>
    res.status(202).json(startBackup(store, req.session.principal.sid)),
  );
  app.get('/api/live/events', (req, res) => {
    const key = hash(req.session.token);
    if ((streams.get(key) || 0) >= 3) return res.status(429).end();
    streams.set(key, (streams.get(key) || 0) + 1);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let pending = false;
    const send = async () => {
      if (pending || res.writableLength > 262144) return;
      pending = true;
      try {
        await sessions.read(req, false, { touch: false });
        res.write(`data: ${JSON.stringify(snapshot(store))}\n\n`);
      } catch {
        res.end();
      } finally {
        pending = false;
      }
    };
    void send();
    const timer = setInterval(send, 1000);
    timer.unref();
    res.on('close', () => {
      clearInterval(timer);
      const count = (streams.get(key) || 1) - 1;
      if (count) streams.set(key, count);
      else streams.delete(key);
    });
  });
  app.post('/api/stations', permission('operator'), (req, res) => {
    const requested = stationSchema.omit({ id: true }).parse(req.body),
      stationId = randomUUID();
    if (store.stationList().some((s) => s.value.key === requested.key))
      throw new Rejected('Publiseringsnøkkelen er allerede i bruk');
    store.db
      .transaction(() => {
        store.initialize(`station:${stationId}`, { ...requested, id: stationId, enabled: false });
        store.initialize(
          `device:${stationId}`,
          defaultDevice(stationId, store.current('gateway').value.publicOrigin, store.environment),
        );
      })
      .immediate();
    const change = store.propose(
      `station:${stationId}`,
      { ...requested, id: stationId },
      1,
      req.session.principal.sid,
    );
    res.status(201).json({ stationId, change });
  });
  app.post('/api/changes', permission('operator'), (req, res) => {
    const { scope, value, revision } = z
      .object({
        scope: z.string().max(100),
        revision: z.number().int().positive(),
        value: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(req.body);
    if (scope === 'gateway') requireRole(req.session.principal, 'administrator');
    res.status(201).json(store.propose(scope, value, revision, req.session.principal.sid));
  });
  app.post(
    '/api/changes/:changeId/:action',
    permission('operator'),
    asyncHandler(async (req, res) => {
      const changeId = id.parse(req.params.changeId),
        change = store.getChange(changeId),
        actor = req.session.principal.sid;
      if (change.scope === 'gateway') requireRole(req.session.principal, 'administrator');
      if (req.params.action === 'test') {
        const report = change.scope.startsWith('device:')
          ? null
          : await probe(store, directory, change, req.session.principal);
        store.begin(changeId, actor);
        if (report) store.health(changeId, true, report);
      } else if (req.params.action === 'confirm') {
        if (
          change.scope === 'gateway' &&
          change.before.adminOrigin !== change.candidate.adminOrigin &&
          (req.headers.origin !== new URL(change.candidate.adminOrigin).origin ||
            req.hostname !== new URL(change.candidate.adminOrigin).hostname)
        )
          throw new Rejected('Åpne den nye adminadressen og bekreft derfra før fristen utløper');
        const report = await probe(store, directory, change, req.session.principal);
        if (!change.scope.startsWith('device:')) store.health(changeId, true, report);
        store.confirm(changeId, actor);
      } else if (req.params.action === 'cancel') store.rollback(changeId, 'cancelled', actor);
      else throw new Rejected('Ukjent handling', 404);
      res.json(store.getChange(changeId));
    }),
  );
  app.post('/api/devices/:stationId/restart', permission('operator'), (req, res) => {
    const stationId = id.parse(req.params.stationId),
      station = store.current(`station:${stationId}`).value;
    if (
      !station.enabled ||
      !latest(store, stationId) ||
      store.clock() - Date.parse(latest(store, stationId).receivedAt) > 30000
    )
      throw new Rejected('Enheten har ingen fersk forbindelse');
    if (
      store.db
        .prepare("SELECT 1 FROM commands WHERE station_id=? AND kind='restart' AND created_at>?")
        .get(stationId, store.clock() - 60000)
    )
      throw new Rejected('Vent ett minutt mellom omstarter', 429);
    const commandId = store.queueCommand(stationId, 'restart', {}, store.clock() + 30000);
    store.audit(req.session.principal.sid, 'restart_requested', { stationId, commandId });
    res.status(202).json({ commandId });
  });
  app.post(
    '/api/devices/:stationId/certificate',
    permission('administrator'),
    asyncHandler(async (req, res) => {
      const stationId = id.parse(req.params.stationId);
      store.current(`station:${stationId}`);
      if (!certificates) throw new Rejected('Sertifikatutsteder er ikke konfigurert', 503);
      const bundle = await certificates.issue(stationId),
        configuration = store.current(`device:${stationId}`).value;
      store.audit(req.session.principal.sid, 'certificate_issued', {
        stationId,
        fingerprint: bundle.fingerprint,
      });
      res.json({
        ...bundle,
        configuration,
        configurationHash: hash(configuration),
        environment: store.environment,
      });
    }),
  );
  app.get('/api/audit', permission('administrator'), (_req, res) => res.json(store.events()));
  app.get('/api/certificates', permission('administrator'), (_req, res) =>
    res.json(
      store.db
        .prepare(
          'SELECT id,station_id,common_name,expires_at,revoked_at FROM certificates ORDER BY expires_at DESC LIMIT 200',
        )
        .all(),
    ),
  );
  app.post('/api/certificates/:certificateId/revoke', permission('administrator'), (req, res) => {
    const certificateId = id.parse(req.params.certificateId);
    const changed = store.db
      .prepare('UPDATE certificates SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .run(store.clock(), certificateId);
    if (!changed.changes) throw new Rejected('Sertifikatet finnes ikke eller er allerede sperret', 404);
    store.audit(req.session.principal.sid, 'certificate_revoked', { certificateId });
    res.json({ ok: true });
  });
  app.get('/api/history/:stationId/:date', (req, res) => {
    const stationId = id.parse(req.params.stationId),
      station = store.current(`station:${stationId}`).value;
    res.json({
      ...history(store, stationId, req.params.date),
      astronomy: astronomy(station, req.params.date),
    });
  });
  app.get('/api/reports/:stationId/:period', (req, res) => {
    const stationId = id.parse(req.params.stationId);
    store.current(`station:${stationId}`);
    res.json(periodReport(store, stationId, req.params.period));
  });
  app.get('/api/promotion', permission('administrator'), (_req, res) => {
    if (store.environment !== 'development')
      throw new Rejected('Bare utvikling kan eksportere en overføringspakke');
    if (store.changes().some((c) => ['draft', 'testing', 'confirming'].includes(c.state)))
      throw new Rejected('Avslutt åpne tester før overføring');
    const gateway = store.current('gateway').value;
    res.json({
      format: 'wg-promotion-1',
      source: store.environment,
      createdAt: new Date(store.clock()).toISOString(),
      gateway: Object.fromEntries(safeGatewayFields.map((k) => [k, gateway[k]])),
      stations: store.stationList().map((s) => s.value),
    });
  });
  app.post('/api/promotion', permission('administrator'), (req, res) => {
    if (store.environment !== 'production') throw new Rejected('Pakken skal importeres i produksjon');
    const promotion = z
      .object({
        format: z.literal('wg-promotion-1'),
        source: z.literal('development'),
        createdAt: z.string().datetime(),
        gateway: z.record(z.string(), z.number()),
        stations: z.array(stationSchema).max(100),
      })
      .strict()
      .parse(req.body);
    if (Object.keys(promotion.gateway).some((k) => !safeGatewayFields.includes(k)))
      throw new Rejected('Pakken inneholder miljøspesifikke innstillinger', 400);
    const result = store.db
      .transaction(() => {
        const changes = [];
        const current = store.current('gateway');
        changes.push(
          store.propose(
            'gateway',
            { ...current.value, ...promotion.gateway },
            current.revision,
            req.session.principal.sid,
          ),
        );
        for (const station of promotion.stations) {
          try {
            store.current(`station:${station.id}`);
          } catch (e) {
            if (e.status !== 404) throw e;
            store.initialize(`station:${station.id}`, { ...station, enabled: false });
            store.initialize(
              `device:${station.id}`,
              defaultDevice(station.id, store.current('gateway').value.publicOrigin, store.environment),
            );
          }
          const c = store.current(`station:${station.id}`);
          changes.push(store.propose(c.scope, station, c.revision, req.session.principal.sid));
        }
        store.audit(req.session.principal.sid, 'promotion_imported', {
          source: promotion.source,
          changeIds: changes.map((c) => c.id),
        });
        return changes;
      })
      .immediate();
    res.status(201).json(result);
  });
  app.use(express.static(resolve('web/dist'), { index: false, maxAge: '1h' }));
  app.get('/', (_req, res) => res.sendFile(resolve('web/dist/index.html'), { dotfiles: 'allow' }));
  app.get('/health/ready', (_req, res) => {
    store.current('gateway');
    res.json({ status: 'ok' });
  });
  return { app: errors(app), sessions };
}

export function publicApp({ store, config }) {
  const app = baseApp(config);
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
  const authorized = (token) => config.publicToken.length >= 32 && equal(token, config.publicToken);
  app.use((req, res, next) =>
    authorized(req.headers.authorization?.replace(/^Bearer /, ''))
      ? next()
      : res.status(401).json({ error: 'Lesetilgang kreves' }),
  );
  app.get('/weather/current', (_req, res) => res.json(snapshot(store)));
  app.get('/files/:stationKey/:filename', (req, res) => {
    const station = store
      .stationList()
      .find(
        (s) =>
          s.value.enabled &&
          s.value.key === req.params.stationKey &&
          s.value.exportName === req.params.filename,
      );
    if (!station) throw new Rejected('Filen finnes ikke', 404);
    res
      .set('Cache-Control', 'no-store')
      .sendFile(station.value.exportName, { root: store.safe('stations', station.value.id, 'exports') });
  });
  errors(app);
  return {
    app,
    attachSockets(server) {
      const io = new SocketServer(server, {
        maxHttpBufferSize: 8192,
        perMessageDeflate: false,
        serveClient: false,
        allowRequest: (req, callback) =>
          callback(
            null,
            !req.headers.origin ||
              req.headers.origin === new URL(store.current('gateway').value.publicOrigin).origin,
          ),
      });
      io.use((socket, next) =>
        authorized(socket.handshake.auth?.token) && io.engine.clientsCount <= 100
          ? next()
          : next(new Error('Lesetilgang kreves')),
      );
      const stopLegacy = attachLegacySockets(io, store);
      let previous = '';
      const timer = setInterval(() => {
        if (!io.engine.clientsCount) return;
        const data = snapshot(store),
          signature = hash(data);
        if (signature !== previous) {
          previous = signature;
          io.emit('file-content', data);
        }
      }, 1000);
      timer.unref();
      return () => {
        clearInterval(timer);
        stopLegacy();
        io.close();
      };
    },
  };
}
