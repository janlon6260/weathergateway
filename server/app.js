import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { resolve, join } from 'node:path';
import { accessSync, constants, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Rejected, hash } from './store.js';
import { Sessions, requireRole, privateNetworks, equal } from './auth.js';
import { stationSchema, deviceSchema, defaultDevice, databaseSchema, id } from './schema.js';
import { snapshot, latest, history, periodReport, legacy } from './observations.js';
import { astronomy } from './astronomy.js';
import { storageHealth } from './maintenance.js';
import { startBackup, listBackups } from './backups.js';
import { databaseStatus } from './database-queue.js';
import { uploadFirmware, proposeFirmware, firmwareReleases } from './firmware-updates.js';
import { alarmStatus } from './alarms.js';
import { climateDay } from './weather-analytics.js';
import { records, climateText, renderTemplate } from './reports.js';
import { importHistory } from './history-import.js';
import { readiness, acceptanceChecks, deploymentFingerprint } from './readiness.js';
import { validitySchema } from './certificate-validity.js';
import { logSession, readDeviceLogs } from './device-logs.js';
import { verifyUsbFirmware } from './usb-firmware.js';
import { adminSnapshot } from './admin-live.js';
import { liveSnapshotIntervalMs } from '../shared/freshness.js';
import { recentPackets } from './raw-packets.js';
import { ApiClients, PublicAccess } from './api-clients.js';
import { attachWeatherSockets } from './weather-sockets.js';

const safeGatewayFields = [
  'confirmationSeconds',
  'sessionIdleMinutes',
  'sessionAbsoluteHours',
  'retentionDays',
  'warningSeconds',
  'downSeconds',
  'dataWarningSeconds',
  'dataDownSeconds',
  'deviceContactSeconds',
  'databaseLoggingEnabled',
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
  const json = express.json({ limit: '256kb', strict: true });
  app.use((req, res, next) =>
    req.method === 'POST' && req.path === '/api/firmware' ? next() : json(req, res, next),
  );
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
export async function probe(store, directory, change, principal, databaseWriter, notifications) {
  if (change.scope.startsWith('device:') || change.scope.startsWith('firmware:')) {
    if (!change.health || store.clock() - change.health.at > 30000)
      throw new Rejected('Venter på bekreftelse og telemetri fra enheten');
    return change.health;
  }
  accessSync(store.safe('system'), constants.R_OK | constants.W_OK);
  const report = { storage: 'ok', schema: 'ok' };
  if (change.scope === 'notifications') {
    if (!notifications) throw new Rejected('Varslingstjenesten er ikke tilgjengelig', 503);
    Object.assign(report, await notifications.verify(change.candidate));
  }
  if (change.scope === 'gateway')
    Object.assign(report, await directory.probe(principal, change.candidate.directory));
  if (change.scope.startsWith('database:')) {
    if (!databaseWriter) throw new Rejected('Databasetjenesten er ikke tilgjengelig', 503);
    Object.assign(report, await databaseWriter.probe(change.candidate));
  }
  if (change.scope.startsWith('station:'))
    for (const template of change.candidate.templates || [])
      renderTemplate(
        template.content,
        { station: change.candidate, weather: legacy(store, change.candidate) },
        { html: template.name.endsWith('.html') },
      );
  return report;
}
export function controlApp({
  store,
  config,
  directory,
  certificates,
  certificateManager,
  databaseWriter,
  firmwareBuilds,
  notifications,
}) {
  const app = baseApp(config),
    apiClients = new ApiClients(store, config),
    sessions = new Sessions(store, directory, { secure: config.secureCookies }),
    allowedNetwork = privateNetworks(config.adminCidrs),
    streams = new Map();
  app.use((_req, res, next) => {
    res.set('Permissions-Policy', 'serial=(self)');
    next();
  });
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
        touch:
          !['/state', '/live', '/live/events', '/packets'].includes(req.path) &&
          !/\/devices\/[^/]+\/logs(?:\/session)?$/.test(req.path),
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
      databases: admin ? databaseStatus(store) : [],
      databasePasswordKeys: admin ? Object.keys(config.databasePasswords || {}) : [],
      databaseAllowlist: admin ? config.databaseAllowlist || [] : [],
      databaseLanEndpoints: admin ? config.databaseLanEndpoints || [] : [],
      apiClients: admin ? apiClients.list() : [],
      firmwareReleases: admin ? firmwareReleases(store) : [],
      alarms: alarmStatus(store),
      notifications: admin && notifications ? notifications.status() : null,
      configurationStorage: {
        backend: store.db.backend || 'sqlite-test',
        database: config.configurationDatabase?.database || null,
      },
      devices:
        admin || req.session.principal.roles.includes('operator')
          ? store.configurations('device:').map((device) => {
              const observation = latest(store, device.value.stationId);
              return {
                ...device,
                delivery: (() => {
                  const row = store.db
                    .prepare('SELECT * FROM device_status WHERE station_id=?')
                    .get(device.value.stationId);
                  return row ? { ...JSON.parse(row.payload), receivedAt: row.received_at } : null;
                })(),
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
          ? store
              .changes()
              .filter(
                (c) =>
                  admin ||
                  (c.scope !== 'gateway' &&
                    !c.scope.startsWith('database:') &&
                    !c.scope.startsWith('firmware:') &&
                    c.scope !== 'notifications'),
              )
          : [],
      commands: admin || req.session.principal.roles.includes('operator') ? store.commandList() : [],
      now: store.clock(),
    });
  });
  app.get('/api/live', (_req, res) => res.json(adminSnapshot(store)));
  app.get('/api/packets', (req, res) => {
    const query = z.object({ stationId: id.optional() }).strict().parse(req.query);
    if (query.stationId) store.current(`station:${query.stationId}`);
    res.json(recentPackets(store, query.stationId));
  });
  app.get('/api/connections', permission('administrator'), (_req, res) => res.json(apiClients.list()));
  app.post('/api/connections', permission('administrator'), (req, res) =>
    res.status(201).json(apiClients.create(req.body, req.session.principal.sid)),
  );
  app.put('/api/connections/:id', permission('administrator'), (req, res) => {
    const body = z
      .object({ revision: z.number().int().positive(), value: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(req.body);
    res.json(apiClients.update(req.params.id, body.revision, body.value, req.session.principal.sid));
  });
  app.post('/api/connections/:id/rotate', permission('administrator'), (req, res) => {
    const body = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
    res.json(apiClients.rotate(req.params.id, body.revision, req.session.principal.sid));
  });
  app.get('/api/notifications', permission('administrator'), (_req, res) => {
    if (!notifications) throw new Rejected('Varslingstjenesten er ikke tilgjengelig', 503);
    res.json(notifications.status());
  });
  app.post('/api/notifications', permission('administrator'), (req, res) => {
    if (!notifications) throw new Rejected('Varslingstjenesten er ikke tilgjengelig', 503);
    const body = z
      .object({ revision: z.number().int().positive(), value: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(req.body);
    res
      .status(201)
      .json(
        store.propose(
          'notifications',
          notifications.prepare(body.value),
          body.revision,
          req.session.principal.sid,
        ),
      );
  });
  app.post(
    '/api/notifications/test',
    permission('administrator'),
    rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false }),
    asyncHandler(async (req, res) => {
      if (!notifications) throw new Rejected('Varslingstjenesten er ikke tilgjengelig', 503);
      const body = z
          .object({ value: z.record(z.string(), z.unknown()), send: z.boolean().default(false) })
          .strict()
          .parse(req.body),
        settings = notifications.prepare(body.value);
      res.json(
        body.send
          ? await notifications.test(settings, req.session.principal.sid)
          : await notifications.verify({ ...settings, enabled: true }),
      );
    }),
  );
  app.get('/api/readiness', permission('administrator'), (_req, res) => res.json(readiness(store, config)));
  app.post('/api/readiness/evidence', permission('administrator'), (req, res) => {
    const evidence = z
      .object({
        checkId: z.enum(Object.keys(acceptanceChecks)),
        configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
        passed: z.boolean(),
        note: z.string().trim().min(20).max(2000),
      })
      .strict()
      .parse(req.body);
    if (evidence.configurationHash !== deploymentFingerprint(store))
      throw new Rejected('Innstillingene er endret. Kontroller produksjonsstatusen på nytt.', 409);
    store.db
      .prepare('INSERT OR REPLACE INTO deployment_acceptance VALUES (?,?,?,?,?,?)')
      .run(
        evidence.checkId,
        evidence.configurationHash,
        store.clock(),
        req.session.principal.sid,
        Number(evidence.passed),
        evidence.note,
      );
    store.audit(req.session.principal.sid, 'deployment_acceptance_recorded', {
      checkId: evidence.checkId,
      passed: evidence.passed,
      configurationHash: evidence.configurationHash,
    });
    res.json(readiness(store, config));
  });
  app.post('/api/alarms/events/:eventId/acknowledge', permission('operator'), (req, res) => {
    const eventId = z.coerce.number().int().positive().parse(req.params.eventId);
    const result = store.db
      .prepare(
        'UPDATE alarm_events SET acknowledged_at=?,acknowledged_by=? WHERE id=? AND acknowledged_at IS NULL',
      )
      .run(store.clock(), req.session.principal.sid, eventId);
    if (!result.changes) throw new Rejected('Alarmhendelsen er allerede kvittert eller finnes ikke', 409);
    store.audit(req.session.principal.sid, 'alarm_acknowledged', { eventId });
    res.json({ ok: true });
  });
  app.get('/api/health', permission('administrator'), (_req, res) => {
    res.json({
      environment: store.environment,
      storage: storageHealth(store),
      database: store.db.prepare('SELECT 1 AS ok').get().ok === 1 ? 'ok' : 'error',
      externalDatabases: databaseStatus(store),
      certificatesExpiring: store.db
        .prepare('SELECT station_id,expires_at FROM certificates WHERE revoked_at IS NULL AND expires_at<?')
        .all(store.clock() + 14 * 86400000),
    });
  });
  app.get('/api/backups', permission('administrator'), (_req, res) => res.json(listBackups(store)));
  app.post('/api/backups', permission('administrator'), (req, res) =>
    res.status(202).json(startBackup(store, req.session.principal.sid)),
  );
  app.post(
    '/api/firmware',
    permission('administrator'),
    express.json({ limit: '3mb', strict: true }),
    (req, res) => res.status(201).json(uploadFirmware(store, config, req.body, req.session.principal.sid)),
  );
  app.post('/api/firmware/:releaseId/deploy', permission('administrator'), (req, res) =>
    res.status(201).json(proposeFirmware(store, req.params.releaseId, req.session.principal.sid)),
  );
  app.post(
    '/api/databases/:stationId/test',
    permission('administrator'),
    asyncHandler(async (req, res) => {
      const stationId = id.parse(req.params.stationId);
      store.current(`station:${stationId}`);
      const { password, ...values } = req.body;
      const target = databaseSchema.parse({
        ...values,
        ...(password && databaseWriter
          ? { passwordSecret: databaseWriter.savePassword(password, req.session.principal.sid) }
          : {}),
      });
      if (target.stationId !== stationId) throw new Rejected('Feil stasjonsidentitet', 400);
      if (!databaseWriter) throw new Rejected('Databasetjenesten er ikke tilgjengelig', 503);
      const report = await databaseWriter.probe(target);
      store.audit(req.session.principal.sid, 'database_connection_test', { stationId });
      res.json(report);
    }),
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
        res.write(`data: ${JSON.stringify(adminSnapshot(store))}\n\n`);
      } catch {
        res.end();
      } finally {
        pending = false;
      }
    };
    void send();
    const timer = setInterval(send, liveSnapshotIntervalMs);
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
        store.initialize(`alarms:${stationId}`, { stationId, rules: [] });
        store.initialize(
          `database:${stationId}`,
          databaseSchema.parse({ stationId, stationKey: requested.key }),
        );
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
    if (scope === 'gateway' || scope === 'notifications' || scope.startsWith('database:'))
      requireRole(req.session.principal, 'administrator');
    if (scope.startsWith('firmware:')) throw new Rejected('Velg en signert utgivelse under Firmware', 400);
    if (scope.startsWith('database:')) store.current(`station:${scope.slice(9)}`);
    if (scope.startsWith('alarms:')) store.current(`station:${scope.slice(7)}`);
    let candidate = value;
    if (scope.startsWith('database:') && Object.hasOwn(value, 'password')) {
      if (!databaseWriter) throw new Rejected('Databasetjenesten er ikke tilgjengelig', 503);
      const { password, ...rest } = value;
      candidate = {
        ...rest,
        ...(password
          ? { passwordSecret: databaseWriter.savePassword(password, req.session.principal.sid) }
          : {}),
      };
    }
    res.status(201).json(store.propose(scope, candidate, revision, req.session.principal.sid));
  });
  app.post(
    '/api/changes/:changeId/:action',
    permission('operator'),
    asyncHandler(async (req, res) => {
      const changeId = id.parse(req.params.changeId),
        change = store.getChange(changeId),
        actor = req.session.principal.sid;
      if (
        change.scope === 'gateway' ||
        change.scope === 'notifications' ||
        change.scope.startsWith('database:') ||
        change.scope.startsWith('firmware:')
      )
        requireRole(req.session.principal, 'administrator');
      if (req.params.action === 'test') {
        const report =
          change.scope.startsWith('device:') || change.scope.startsWith('firmware:')
            ? null
            : await probe(store, directory, change, req.session.principal, databaseWriter, notifications);
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
        const report = await probe(
          store,
          directory,
          change,
          req.session.principal,
          databaseWriter,
          notifications,
        );
        if (!change.scope.startsWith('device:') && !change.scope.startsWith('firmware:'))
          store.health(changeId, true, report);
        store.confirm(changeId, actor);
      } else if (req.params.action === 'cancel') store.rollback(changeId, 'cancelled', actor);
      else throw new Rejected('Ukjent handling', 404);
      res.json(store.getChange(changeId));
    }),
  );
  app.get('/api/devices/:stationId/logs', permission('operator'), (req, res) =>
    res.json(readDeviceLogs(store, req.params.stationId, req.query.after)),
  );
  app.post('/api/devices/:stationId/logs/session', permission('operator'), (req, res) =>
    res.status(202).json(logSession(store, req.params.stationId, req.body, req.session.principal.sid)),
  );
  app.post('/api/devices/:stationId/flash/verify', permission('administrator'), (req, res) =>
    res.json(verifyUsbFirmware(store, config, req.params.stationId, req.body, req.session.principal.sid)),
  );
  app.use('/api/firmware-builds', permission('administrator'), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!firmwareBuilds) return next(new Rejected('Firmwarebyggeren er ikke konfigurert', 503));
    next();
  });
  app.get('/api/firmware-builds/stations/:stationId', (req, res) =>
    res.json(firmwareBuilds.status(req.params.stationId)),
  );
  app.post(
    '/api/firmware-builds/stations/:stationId',
    asyncHandler(async (req, res) =>
      res
        .status(202)
        .json(await firmwareBuilds.start(req.params.stationId, req.body, req.session.principal.sid)),
    ),
  );
  app.post('/api/firmware-builds/stations/:stationId/identity', (req, res) =>
    res.json(firmwareBuilds.importIdentity(req.params.stationId, req.body, req.session.principal.sid)),
  );
  app.get('/api/firmware-builds/:buildId/usb', (req, res) =>
    res.json(firmwareBuilds.usb(req.params.buildId)),
  );
  app.post('/api/firmware-builds/:buildId/cancel', (req, res) =>
    res.json(firmwareBuilds.cancel(req.params.buildId, req.session.principal.sid)),
  );
  app.post('/api/firmware-builds/:buildId/usb-complete', (req, res) =>
    res.json(
      firmwareBuilds.usbComplete(
        req.params.buildId,
        req.session.principal.sid,
        z
          .object({ bootConfirmed: z.boolean().default(false) })
          .strict()
          .parse(req.body),
      ),
    ),
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
      if (certificateManager?.pending()?.type === 'ca')
        throw new Rejected('Fullfør CA-endringen før du utsteder enhetssertifikater.');
      const { validity } = z
        .object({ validity: validitySchema.optional() })
        .strict()
        .parse(req.body || {});
      if (config.firmwarePublicKeyFile && !existsSync(config.firmwarePublicKeyFile))
        throw new Rejected('Initialiser sertifikater og firmware-nøkler under Sertifikater først.', 409);
      const bundle = await certificates.issue(stationId, validity),
        configuration = store.current(`device:${stationId}`).value;
      firmwareBuilds?.remember(bundle);
      store.audit(req.session.principal.sid, 'certificate_issued', {
        stationId,
        fingerprint: bundle.fingerprint,
      });
      res.json({
        ...bundle,
        ...(config.firmwarePublicKeyFile
          ? { firmwarePublicKey: readFileSync(config.firmwarePublicKeyFile, 'utf8') }
          : {}),
        configuration,
        configurationHash: hash(configuration),
        environment: store.environment,
      });
    }),
  );
  app.get('/api/audit', permission('administrator'), (_req, res) => res.json(store.events()));
  app.use('/api/pki', permission('administrator'), (_req, _res, next) => {
    if (!certificateManager) return next(new Rejected('Sertifikatbehandling er ikke tilgjengelig', 503));
    next();
  });
  app.get('/api/pki', (_req, res) => res.json(certificateManager.status()));
  app.post(
    '/api/pki/initialize',
    asyncHandler(async (req, res) =>
      res.status(201).json(await certificateManager.initialize(req.body, req.session.principal.sid)),
    ),
  );
  app.post(
    '/api/pki/changes',
    asyncHandler(async (req, res) =>
      res.status(201).json(await certificateManager.stage(req.body, req.session.principal.sid)),
    ),
  );
  for (const operation of ['test', 'confirm', 'rollback'])
    app.post(`/api/pki/changes/:changeId/${operation}`, (req, res) =>
      res.json(certificateManager[operation](id.parse(req.params.changeId), req.session.principal.sid)),
    );
  app.post('/api/pki/export/:type', (req, res) =>
    res.json(certificateManager.export(req.params.type, req.session.principal.sid)),
  );
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
    store.db
      .prepare(
        "UPDATE certificates SET revoked_at=? WHERE id IN (SELECT new_id FROM certificate_renewals WHERE certificate_id=? AND state IN ('queued','issuing','sent'))",
      )
      .run(store.clock(), certificateId);
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
      climate: climateDay(store, station, req.params.date),
      astronomy: astronomy(station, req.params.date),
    });
  });
  app.get('/api/reports/:stationId/:period', (req, res) => {
    const stationId = id.parse(req.params.stationId);
    store.current(`station:${stationId}`);
    res.json(periodReport(store, stationId, req.params.period));
  });
  app.get('/api/records/:stationId', (req, res) => {
    const stationId = id.parse(req.params.stationId);
    store.current(`station:${stationId}`);
    const options = z
      .object({ from: z.string().optional(), to: z.string().optional() })
      .strict()
      .parse(req.query);
    res.json(records(store, stationId, options));
  });
  app.get('/api/report-text/:stationId/:period', (req, res) => {
    const stationId = id.parse(req.params.stationId),
      station = store.current(`station:${stationId}`).value,
      report = periodReport(store, stationId, req.params.period);
    res
      .type('text/plain')
      .attachment(`climate-${station.key}-${report.period}.txt`)
      .send(climateText(station, report));
  });
  app.post('/api/history-import', permission('administrator'), (req, res) =>
    res.json(importHistory(store, req.body, req.session.principal.sid)),
  );
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
            store.initialize(`alarms:${station.id}`, { stationId: station.id, rules: [] });
            store.initialize(
              `database:${station.id}`,
              databaseSchema.parse({ stationId: station.id, stationKey: station.key }),
            );
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
  const access = new PublicAccess(store, config);
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      if (
        !req.headers.origin ||
        !access.policy()?.clients.some((c) => c.origins.includes(req.headers.origin))
      )
        return res.sendStatus(403);
      return res
        .set({
          'Access-Control-Allow-Origin': req.headers.origin,
          'Access-Control-Allow-Methods': 'GET,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization',
          Vary: 'Origin',
        })
        .sendStatus(204);
    }
    req.access = access.authorize(req.headers.authorization?.replace(/^Bearer /, ''), req.headers.origin);
    if (!req.access) return res.status(401).json({ error: 'Lesetilgang krever administratorgodkjenning' });
    res.set('Cache-Control', 'no-store');
    if (req.headers.origin) res.set({ 'Access-Control-Allow-Origin': req.headers.origin, Vary: 'Origin' });
    next();
  });
  app.get('/weather/current', (req, res) => {
    const selectors = req.query.station
      ? [req.query.station]
      : req.query.stations
        ? String(req.query.stations).split(',')
        : [];
    res.json(access.filter(req.access, snapshot(store), selectors));
  });
  app.get('/files/:stationKey/:filename', (req, res) => {
    const station = access
      .permitted(req.access)
      .find(
        (s) =>
          s.key === req.params.stationKey &&
          (s.exportName === req.params.filename || s.templates?.some((t) => t.name === req.params.filename)),
      );
    if (!station) throw new Rejected('Filen finnes ikke', 404);
    res
      .set('Cache-Control', 'no-store')
      .sendFile(req.params.filename, { root: store.safe('stations', station.id, 'exports') });
  });
  errors(app);
  return {
    app,
    attachSockets(server) {
      return attachWeatherSockets(server, store, config);
    },
  };
}
