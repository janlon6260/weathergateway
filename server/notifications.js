import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hash, Rejected } from './store.js';
import { notificationsSchema } from './schema.js';
import { SettingsSecrets } from './settings-secrets.js';
import { freshnessThresholds } from '../shared/freshness.js';
const codes = (error) => (/^[A-Z0-9_]{1,50}$/.test(error?.code || '') ? error.code : 'SMTP_ERROR');
const kinds = {
  station_offline: 'Stasjonen er nede',
  esp_offline: 'Ingen kontakt med ESP32',
  data_age: 'Værdata er forsinket',
  sensor_contact_lost: 'Ingen kontakt med ISS',
  heap_low: 'Lite ledig minne på ESP32',
  spool_dropped: 'ESP32 har mistet kølagrede målinger',
};
export class Notifications {
  constructor(store, config, { transportFactory = nodemailer.createTransport } = {}) {
    this.store = store;
    this.config = config;
    this.transportFactory = transportFactory;
    this.secrets = new SettingsSecrets(store, config.certificateRoot);
    this.running = null;
  }
  settings() {
    return this.store.current('notifications');
  }
  prepare(input) {
    const { password, ...smtp } = input.smtp || {};
    const candidate = notificationsSchema.parse({ ...input, smtp });
    if (password !== undefined && password !== '') {
      z.string().min(1).max(1024).parse(password);
      candidate.smtp.passwordSecret = this.secrets.set(`smtp:${randomUUID()}`, password);
    }
    if (candidate.smtp.authEnabled && !candidate.smtp.passwordSecret)
      throw new Rejected('Angi SMTP-passord når innlogging er aktivert', 400);
    return candidate;
  }
  transport(settings) {
    const smtp = settings.smtp;
    if (!smtp.host || !smtp.from) throw new Rejected('SMTP-vert og avsender må fylles ut', 400);
    return this.transportFactory({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.security === 'tls',
      ignoreTLS: smtp.security === 'none',
      requireTLS: smtp.security === 'starttls',
      ...(smtp.authEnabled ? { auth: { user: smtp.user, pass: this.secrets.get(smtp.passwordSecret) } } : {}),
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ...(smtp.caCertificate ? { ca: smtp.caCertificate } : {}),
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  }
  async verify(settings = this.store.confirmedValue('notifications')) {
    if (!settings.enabled) return { smtp: 'disabled', emailSent: false };
    const transport = this.transport(settings);
    try {
      await transport.verify();
      return { smtp: 'ok', emailSent: false };
    } catch (e) {
      throw new Rejected(`SMTP-test feilet (${codes(e)})`, 409);
    } finally {
      transport.close();
    }
  }
  async test(settings, actor) {
    const transport = this.transport(settings);
    try {
      if (!settings.recipients.length) throw new Rejected('Legg til minst én mottaker', 400);
      await transport.sendMail({
        from: settings.smtp.from,
        to: settings.recipients,
        subject: `WeatherGateway: test (${this.store.environment})`,
        text: 'Dette er en testmelding fra WeatherGateway. SMTP-forbindelsen fungerer.',
      });
      this.store.audit(actor, 'smtp_test_sent', { recipients: settings.recipients.length });
      return { sent: true };
    } catch (error) {
      if (error instanceof Rejected) throw error;
      throw new Rejected(`Testmeldingen kunne ikke sendes (${codes(error)})`, 409);
    } finally {
      transport.close();
    }
  }
  assess(rule, station, now) {
    const sensorAt = Number(
      this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(`last_valid_sensor:${station.id}`)
        ?.value ||
        this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(`station_started:${station.id}`)
          ?.value ||
        now,
    );
    const raw = this.store.db.prepare('SELECT * FROM device_status WHERE station_id=?').get(station.id),
      health = raw ? JSON.parse(raw.payload) : null;
    const contact = health?.lastContactAt || raw?.received_at || sensorAt;
    const sensorAge = Math.max(0, (now - sensorAt) / 1000),
      espAge = Math.max(0, (now - contact) / 1000);
    const seconds =
      rule.thresholdSeconds || freshnessThresholds(this.store.confirmedValue('gateway'), station).downSeconds;
    if (rule.kind === 'heap_low')
      return {
        active:
          !!health &&
          espAge <= 30 &&
          typeof health.freeHeapBytes === 'number' &&
          health.freeHeapBytes < rule.minimumHeapBytes,
        value: health?.freeHeapBytes ?? null,
      };
    if (rule.kind === 'spool_dropped')
      return { active: !!health && espAge <= 30 && health.dropped > 0, value: health?.dropped ?? 0 };
    if (rule.kind === 'esp_offline') return { active: espAge > seconds, value: Math.floor(espAge) };
    return { active: sensorAge > seconds, value: Math.floor(sensorAge) };
  }
  evaluate() {
    const settings = this.store.confirmedValue('notifications');
    if (!settings.enabled) return;
    const now = this.store.clock();
    this.store.db
      .transaction(() => {
        for (const rule of settings.rules.filter((r) => r.enabled))
          for (const row of this.store.stationList()) {
            const station = this.store.confirmedValue(row.scope);
            if (
              !station.enabled ||
              station.model === 'Netatmo' ||
              (rule.stationIds.length && !rule.stationIds.includes(station.id))
            )
              continue;
            const key = `${rule.id}:${station.id}`,
              digest = hash(rule),
              prior = this.store.db.prepare('SELECT payload FROM notification_state WHERE id=?').get(key);
            let state = prior ? JSON.parse(prior.payload) : { active: false, lastSentAt: 0 };
            if (state.hash !== digest) state = { active: false, lastSentAt: 0, hash: digest };
            const condition = this.assess(rule, station, now),
              recovery = state.active && !condition.active;
            const repeat =
              condition.active &&
              state.active &&
              rule.repeatSeconds > 0 &&
              now - state.lastSentAt >= rule.repeatSeconds * 1000;
            if ((condition.active && !state.active) || repeat || (recovery && rule.sendRecovery)) {
              const recipients = rule.recipients.length ? rule.recipients : settings.recipients;
              if (recipients.length) {
                const id = randomUUID();
                this.store.db
                  .prepare(
                    'INSERT INTO notification_outbox(id,created_at,next_attempt,attempts,payload,state) VALUES (?,?,?,0,?,?)',
                  )
                  .run(
                    id,
                    now,
                    now,
                    JSON.stringify({
                      ruleId: rule.id,
                      stationId: station.id,
                      recipients,
                      subject: `${recovery ? 'Gjenopprettet' : 'Varsel'}: ${station.name} – ${rule.name}`,
                      text: `${station.name}\n${recovery ? 'Tilstanden er normal igjen.' : kinds[rule.kind]}\nVerdi: ${condition.value}\nMiljø: ${this.store.environment}\nTid: ${new Date(now).toISOString()}`,
                      recovery,
                    }),
                    'queued',
                  );
                state.lastSentAt = now;
              }
            }
            state.active = condition.active;
            state.value = condition.value;
            this.store.db
              .prepare(
                'INSERT INTO notification_state VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
              )
              .run(key, JSON.stringify(state));
          }
      })
      .immediate();
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.process().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async process() {
    this.evaluate();
    const settings = this.store.confirmedValue('notifications');
    if (!settings.enabled) return;
    this.store.db
      .prepare("UPDATE notification_outbox SET state='queued' WHERE state='sending' AND lease_until<?")
      .run(this.store.clock());
    const next = this.store.db
      .prepare(
        "SELECT * FROM notification_outbox WHERE state='queued' AND next_attempt<=? ORDER BY created_at LIMIT 1",
      )
      .get(this.store.clock());
    if (!next) return;
    if (
      !this.store.db
        .prepare("UPDATE notification_outbox SET state='sending',lease_until=? WHERE id=? AND state='queued'")
        .run(this.store.clock() + 60000, next.id).changes
    )
      return;
    const payload = JSON.parse(next.payload),
      rule = settings.rules.find((r) => r.id === payload.ruleId && r.enabled);
    const station = this.store.stationList().find((s) => s.value.id === payload.stationId)?.value;
    if (
      !rule ||
      !station?.enabled ||
      (rule.stationIds.length && !rule.stationIds.includes(payload.stationId))
    ) {
      this.store.db.prepare("UPDATE notification_outbox SET state='cancelled' WHERE id=?").run(next.id);
      return;
    }
    let transport;
    try {
      transport = this.transport(settings);
      await transport.sendMail({
        from: settings.smtp.from,
        to: rule.recipients.length ? rule.recipients : settings.recipients,
        subject: payload.subject,
        text: payload.text,
        messageId: `<${next.id}@weathergateway.local>`,
      });
      this.store.db
        .prepare(
          "UPDATE notification_outbox SET state='sent',sent_at=?,last_error=NULL,lease_until=0 WHERE id=?",
        )
        .run(this.store.clock(), next.id);
      this.store.audit('notifications', 'email_sent', {
        id: next.id,
        stationId: payload.stationId,
        recovery: payload.recovery,
      });
    } catch (error) {
      const attempts = next.attempts + 1;
      this.store.db
        .prepare('UPDATE notification_outbox SET attempts=?,next_attempt=?,last_error=?,state=? WHERE id=?')
        .run(
          attempts,
          this.store.clock() + Math.min(3600000, 15000 * 2 ** Math.min(attempts, 8)),
          codes(error),
          attempts >= 12 ? 'failed' : 'queued',
          next.id,
        );
    } finally {
      transport?.close();
    }
  }
  status() {
    return {
      settings: this.settings(),
      events: this.store.db
        .prepare(
          'SELECT id,created_at,state,sent_at,attempts,last_error,payload FROM notification_outbox ORDER BY created_at DESC LIMIT 100',
        )
        .all()
        .map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
    };
  }
}
