import mqtt from 'mqtt';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { ackSchema, id } from './schema.js';
import { hash, Rejected } from './store.js';
import { z } from 'zod';
import { ingest, exportStation, latest } from './observations.js';
import { maintain, writeReports } from './maintenance.js';
import { publicProjection } from './public-projection.js';
import { firmwareChunk } from './firmware-updates.js';
import { requestCertificateRenewal } from './pki.js';
import { checkAlarms } from './alarms.js';

export function deviceHealth(store, stationId) {
  const observation = latest(store, stationId);
  if (
    !observation?.sensorContact ||
    !observation.configurationHash ||
    store.clock() - Date.parse(observation.receivedAt) > 15000 ||
    store.clock() - Date.parse(observation.observedAt) > 15000
  )
    return false;
  const change = store
    .changes()
    .find(
      (c) =>
        c.scope === `device:${stationId}` &&
        c.state === 'testing' &&
        hash(c.candidate) === observation.configurationHash,
    );
  if (!change) return false;
  const command = store.db
    .prepare("SELECT * FROM commands WHERE change_id=? AND kind='test_config' AND state='testing'")
    .get(change.id);
  if (!command || Date.parse(observation.observedAt) < command.created_at) return false;
  store.health(change.id, true, {
    deviceAck: true,
    deviceTelemetry: true,
    configurationHash: observation.configurationHash,
  });
  return true;
}
export function firmwareHealth(store, stationId) {
  const observation = latest(store, stationId);
  if (
    !observation?.sensorContact ||
    !observation.firmwareReleaseId ||
    store.clock() - Date.parse(observation.receivedAt) > 15000 ||
    store.clock() - Date.parse(observation.observedAt) > 15000
  )
    return false;
  const change = store
    .changes()
    .find(
      (c) =>
        c.scope === `firmware:${stationId}` &&
        c.state === 'testing' &&
        c.candidate.releaseId === observation.firmwareReleaseId,
    );
  if (!change) return false;
  const command = store.db
    .prepare("SELECT * FROM commands WHERE change_id=? AND kind='test_firmware' AND state='testing'")
    .get(change.id);
  if (!command || Date.parse(observation.observedAt) < command.created_at) return false;
  store.health(change.id, true, {
    firmwareAck: true,
    firmwareTelemetry: true,
    releaseId: observation.firmwareReleaseId,
  });
  return true;
}
export function handleAck(store, stationId, input) {
  const ack = ackSchema.parse(input);
  if (ack.stationId !== stationId) throw new Error('Feil ACK-identitet');
  return store.db
    .transaction(() => {
      store.sweep();
      const command = store.db
        .prepare('SELECT * FROM commands WHERE id=? AND station_id=?')
        .get(ack.commandId, stationId);
      if (
        !command ||
        command.deadline <= store.clock() ||
        ['applied', 'rejected', 'expired'].includes(command.state)
      )
        return false;
      if (command.change_id) {
        const c = store.getChange(command.change_id);
        if (c.scope.startsWith('firmware:') && ['testing', 'confirming'].includes(c.state)) {
          if (
            !['rejected', 'rolled_back'].includes(ack.status) &&
            ack.firmwareReleaseId !== c.candidate.releaseId
          )
            throw new Error('ACK gjelder en annen firmware');
          if (ack.status === 'applied' && command.kind === 'commit_firmware' && c.state === 'confirming') {
            store.db.prepare("UPDATE changes SET state='confirmed' WHERE id=?").run(c.id);
            store.audit(stationId, 'firmware_confirmed', {
              changeId: c.id,
              releaseId: ack.firmwareReleaseId,
            });
          } else if (['rejected', 'rolled_back'].includes(ack.status))
            store.rollback(c.id, 'firmware_rejected', stationId);
        } else if (['testing', 'confirming'].includes(c.state)) {
          if (
            ack.status === 'testing' &&
            command.kind === 'test_config' &&
            ack.configurationHash === hash(c.candidate)
          ) {
            /* Wait for telemetry from the candidate configuration as well. */
          } else if (
            ack.status === 'applied' &&
            command.kind === 'commit_config' &&
            c.state === 'confirming' &&
            ack.configurationHash === hash(c.candidate)
          ) {
            store.db.prepare("UPDATE changes SET state='confirmed' WHERE id=?").run(c.id);
            store.audit(stationId, 'device_confirmed', { changeId: c.id });
          } else if (['rejected', 'rolled_back'].includes(ack.status))
            store.rollback(c.id, 'device_rejected', stationId);
          else if (['testing', 'applied'].includes(ack.status) && ack.configurationHash !== hash(c.candidate))
            throw new Error('ACK gjelder en annen konfigurasjon');
        }
      }
      store.db
        .prepare('UPDATE commands SET state=?,ack_json=? WHERE id=?')
        .run(ack.status, JSON.stringify(ack), ack.commandId);
      if (command.kind === 'renew_certificate') {
        const payload = JSON.parse(command.payload);
        if (ack.status === 'applied') {
          if (ack.certificateId !== payload.certificateId) throw new Error('Feil sertifikatkvittering');
          const old = store.db
            .prepare('SELECT revoked_at FROM certificates WHERE id=?')
            .get(payload.previousCertificateId);
          if (old?.revoked_at !== null) {
            store.db
              .prepare('UPDATE certificates SET revoked_at=? WHERE id=?')
              .run(store.clock(), payload.certificateId);
            store.db.prepare("UPDATE commands SET state='rejected' WHERE id=?").run(command.id);
            store.db
              .prepare("UPDATE certificate_renewals SET state='failed',error='REVOKED' WHERE command_id=?")
              .run(command.id);
            return false;
          }
          store.db
            .prepare('UPDATE certificates SET revoked_at=? WHERE id=? AND station_id=?')
            .run(store.clock(), payload.previousCertificateId, stationId);
          store.db
            .prepare("UPDATE certificate_renewals SET state='applied' WHERE command_id=?")
            .run(command.id);
        } else if (['rejected', 'rolled_back'].includes(ack.status)) {
          store.db
            .prepare('UPDATE certificates SET revoked_at=? WHERE id=?')
            .run(store.clock(), payload.certificateId);
          store.db
            .prepare(
              "UPDATE certificate_renewals SET state='failed',error='DEVICE_REJECTED' WHERE command_id=?",
            )
            .run(command.id);
        }
      }
      deviceHealth(store, stationId);
      firmwareHealth(store, stationId);
      store.audit(stationId, 'command_ack', { commandId: ack.commandId, status: ack.status });
      return true;
    })
    .immediate();
}
export function handleMessage(store, topic, buffer) {
  if (buffer.byteLength > 16384) throw new Error('Meldingen er for stor');
  const parts = topic.split('/');
  if (
    parts.length !== 6 ||
    parts[0] !== 'wg' ||
    parts[1] !== 'v1' ||
    parts[2] !== store.environment ||
    parts[3] !== 'stations'
  )
    throw new Error('Feil MQTT-emne');
  const stationId = id.parse(parts[4]);
  const message = JSON.parse(buffer.toString('utf8'));
  if (parts[5] === 'telemetry') {
    const inserted = ingest(store, stationId, message);
    deviceHealth(store, stationId);
    firmwareHealth(store, stationId);
    return inserted;
  }
  if (parts[5] === 'acks') return handleAck(store, stationId, message);
  return false;
}
export function durableTelemetryReceipt(store, stationId, payload, { undated = false } = {}) {
  if (payload.length > 16384) throw new Error('Meldingen er for stor');
  const body = JSON.parse(payload.toString('utf8'));
  const identity = z
    .object({
      stationId: id,
      bootId: id,
      sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .passthrough()
    .parse(body);
  if (identity.stationId !== stationId) throw new Error('Feil kvitteringsidentitet');
  let status = 'stored',
    reason;
  if (undated) reason = 'CLOCK_UNAVAILABLE';
  else
    try {
      handleMessage(store, `wg/v1/${store.environment}/stations/${stationId}/telemetry`, payload);
    } catch (error) {
      if (!(error instanceof z.ZodError) && !(error instanceof Rejected && error.status < 500)) throw error;
      reason = error instanceof z.ZodError ? 'INVALID_TELEMETRY' : 'TELEMETRY_REJECTED';
    }
  if (reason) {
    store.db
      .prepare('INSERT OR IGNORE INTO telemetry_rejections VALUES (?,?,?,?,?,?)')
      .run(stationId, body.bootId, body.sequence, store.clock(), reason, payload.toString('utf8'));
    status = 'rejected';
  }
  return {
    version: 1,
    stationId,
    bootId: body.bootId,
    sequence: body.sequence,
    status,
    ...(reason ? { reason } : {}),
  };
}
export function startWorker(store, config, databaseWriter) {
  if (
    !config.mqttUrl ||
    !config.mqttCaFile ||
    !config.mqttCertFile ||
    !config.mqttKeyFile ||
    new URL(config.mqttUrl).protocol !== 'mqtts:'
  )
    throw new Error('MQTT krever mqtts-URL, CA, klientsertifikat og privatnøkkel');
  const client = mqtt.connect(config.mqttUrl, {
    protocolVersion: 5,
    clientId: `wg-worker-${store.environment}`,
    clean: true,
    keepalive: 30,
    connectTimeout: 10000,
    reconnectPeriod: 2000,
    queueQoSZero: false,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    ca: readFileSync(config.mqttCaFile),
    cert: readFileSync(config.mqttCertFile),
    key: readFileSync(config.mqttKeyFile),
  });
  const projection = publicProjection(store);
  projection.sync();
  const root = `wg/v1/${store.environment}/stations`;
  client.on('connect', () =>
    client.subscribe(
      [
        `${root}/+/telemetry`,
        `${root}/+/telemetry-undated`,
        `${root}/+/status`,
        `${root}/+/acks`,
        `${root}/+/firmware-request`,
        `${root}/+/certificate-request`,
      ],
      { qos: 1 },
    ),
  );
  client.on('error', (error) =>
    console.error(JSON.stringify({ event: 'mqtt_error', code: error.code || error.name })),
  );
  const rates = new Map();
  let rejected = 0;
  client.on('message', (topic, payload) => {
    const key = topic.split('/')[4],
      now = Date.now();
    let bucket = rates.get(key);
    if (!bucket) {
      if (rates.size >= 512) {
        rejected++;
        return;
      }
      rates.set(key, (bucket = { at: now, tokens: 40 }));
    }
    bucket.tokens = Math.min(40, bucket.tokens + Math.max(0, now - bucket.at) * 0.02);
    bucket.at = now;
    if (bucket.tokens < 1) {
      rejected++;
      return;
    }
    bucket.tokens--;
    try {
      if (topic === `${root}/${key}/telemetry` || topic === `${root}/${key}/telemetry-undated`) {
        const receipt = durableTelemetryReceipt(store, id.parse(key), payload, {
          undated: topic.endsWith('/telemetry-undated'),
        });
        client.publish(`${root}/${key}/telemetry-receipt`, JSON.stringify(receipt), {
          qos: 1,
          retain: false,
          properties: { messageExpiryInterval: 30 },
        });
      } else if (topic === `${root}/${key}/certificate-request`) {
        const request = z
          .object({ version: z.literal(1), stationId: id, certificateId: id })
          .strict()
          .parse(JSON.parse(payload.toString('utf8')));
        if (request.stationId !== id.parse(key)) throw new Error('Feil sertifikatidentitet');
        requestCertificateRenewal(store, key, request.certificateId);
      } else if (topic === `${root}/${key}/status`) {
        const body = z
          .object({
            online: z.boolean(),
            pending: z.number().int().nonnegative().optional(),
            capacity: z.number().int().positive().optional(),
            dropped: z.number().int().nonnegative().optional(),
            clockSynchronized: z.boolean().optional(),
            security: z
              .object({
                chipRevision: z.number().int().nonnegative(),
                secureBoot: z.boolean(),
                flashEncryption: z.boolean(),
                nvsEncryption: z.boolean(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .parse(JSON.parse(payload.toString('utf8')));
        store.db
          .prepare('INSERT OR REPLACE INTO device_status VALUES (?,?,?)')
          .run(id.parse(key), store.clock(), JSON.stringify(body));
      } else if (topic === `${root}/${key}/firmware-request`) {
        id.parse(key);
        if (payload.length > 1024) throw new Error('For stor firmwareforespørsel');
        const chunk = firmwareChunk(store, key, JSON.parse(payload.toString('utf8')));
        client.publish(`${root}/${key}/firmware-data`, JSON.stringify(chunk), {
          qos: 1,
          retain: false,
          properties: { messageExpiryInterval: 10 },
        });
      } else handleMessage(store, topic, payload);
    } catch {
      rejected++;
    }
  });
  let counter = 0;
  const timer = setInterval(() => {
    try {
      store.sweep();
      if (databaseWriter)
        void databaseWriter.drain().catch(() => {
          console.error(JSON.stringify({ event: 'database_worker_failed' }));
        });
      counter++;
      if (counter % 60 === 0 && rejected) {
        console.warn(JSON.stringify({ event: 'mqtt_rejected', count: rejected }));
        rejected = 0;
      }
      if (counter % 5 === 0 && client.connected) {
        const file = store.safe('system', 'worker-heartbeat.json');
        writeFileSync(`${file}.tmp`, JSON.stringify({ environment: store.environment, at: store.clock() }), {
          mode: 0o640,
        });
        renameSync(`${file}.tmp`, file);
      }
      if (counter % 2 === 0) projection.sync();
      for (const station of store
        .stationList()
        .map((s) => store.confirmedConfiguration(s.scope))
        .filter((s) => s.value.enabled && s.value.model !== 'Netatmo')) {
        if (counter % 5 === 0) exportStation(store, station.value);
        if (counter % 5 === 0) deviceHealth(store, station.value.id);
        if (counter % 5 === 0) firmwareHealth(store, station.value.id);
      }
      if (client.connected)
        for (const command of store.db
          .prepare(
            "SELECT * FROM commands WHERE state IN ('queued','sent','received') AND deadline>? AND (attempt_at IS NULL OR attempt_at<?) ORDER BY sequence LIMIT 20",
          )
          .all(store.clock(), store.clock() - 5000)) {
          const data = {
            version: 1,
            stationId: command.station_id,
            commandId: command.id,
            sequence: command.sequence,
            kind: command.kind,
            issuedAt: new Date(command.created_at).toISOString(),
            expiresAt: new Date(command.deadline).toISOString(),
            ...JSON.parse(command.payload),
          };
          client.publish(
            `${root}/${command.station_id}/commands`,
            JSON.stringify(data),
            {
              qos: 1,
              retain: false,
              properties: {
                messageExpiryInterval: Math.max(1, Math.floor((command.deadline - store.clock()) / 1000)),
              },
            },
            (error) => {
              if (error) console.error(JSON.stringify({ event: 'publish_failed', code: error.code }));
            },
          );
          store.db
            .prepare("UPDATE commands SET state='sent',attempt_at=? WHERE id=?")
            .run(store.clock(), command.id);
        }
      if (counter % 10 === 0) {
        maintain(store);
        checkAlarms(store);
      }
      if (counter % 3600 === 0 || counter === 1) {
        maintain(store, { pruneRaw: true });
        writeReports(store);
        store.checkpoint();
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'worker_failed', code: error.code || error.name }));
    }
  }, 1000);
  timer.unref();
  return () =>
    new Promise((resolve) => {
      clearInterval(timer);
      projection.close();
      client.end(false, {}, resolve);
    });
}
