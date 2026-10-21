import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateScope, id } from './schema.js';
import { ConfigurationDatabase } from './config-database.js';

export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export class Rejected extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
export const fail = (message, status) => {
  throw new Rejected(message, status);
};

const schema = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS configuration(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,scope TEXT NOT NULL,base_revision INTEGER NOT NULL,before_json TEXT NOT NULL,candidate_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,deadline INTEGER,health_json TEXT,actor TEXT NOT NULL,reason TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS one_change ON changes(scope) WHERE state IN ('draft','testing','confirming');
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,principal TEXT NOT NULL,created_at INTEGER NOT NULL,last_at INTEGER NOT NULL,verified_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS observations(station_id TEXT NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER NOT NULL,observed_at INTEGER NOT NULL,received_at INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(station_id,boot_id,sequence));
CREATE INDEX IF NOT EXISTS observation_time ON observations(station_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS observation_retention ON observations(observed_at);
CREATE INDEX IF NOT EXISTS observation_received ON observations(received_at);
CREATE INDEX IF NOT EXISTS observation_station_received ON observations(station_id,received_at DESC);
CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,station_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,deadline INTEGER NOT NULL,state TEXT NOT NULL,change_id TEXT,attempt_at INTEGER,ack_json TEXT,sequence INTEGER);
CREATE INDEX IF NOT EXISTS queued_commands ON commands(state,deadline);
CREATE TABLE IF NOT EXISTS certificates(id TEXT PRIMARY KEY,station_id TEXT NOT NULL,common_name TEXT NOT NULL,serial TEXT NOT NULL,expires_at INTEGER NOT NULL,certificate TEXT NOT NULL,revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS rollups(station_id TEXT NOT NULL,period TEXT NOT NULL,metric TEXT NOT NULL,minimum REAL NOT NULL,maximum REAL NOT NULL,total REAL NOT NULL,samples INTEGER NOT NULL,min_at INTEGER NOT NULL,max_at INTEGER NOT NULL,PRIMARY KEY(station_id,period,metric));
CREATE TABLE IF NOT EXISTS rain_state(station_id TEXT NOT NULL,day TEXT NOT NULL,last_at INTEGER NOT NULL,last_counter REAL NOT NULL,unit TEXT NOT NULL,total_mm REAL NOT NULL,resets INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(station_id,day));
CREATE TABLE IF NOT EXISTS iss_rain(station_id TEXT PRIMARY KEY,transmitter_id INTEGER NOT NULL,last_at INTEGER NOT NULL,counter INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS weather_segments(station_id TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(station_id,start_at));
CREATE INDEX IF NOT EXISTS weather_segments_end ON weather_segments(station_id,end_at);
CREATE TABLE IF NOT EXISTS weather_bins(station_id TEXT NOT NULL,hour INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(station_id,hour));
CREATE TABLE IF NOT EXISTS firmware_releases(id TEXT PRIMARY KEY,station_id TEXT NOT NULL,manifest TEXT NOT NULL,signature TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(station_id,manifest));
CREATE TABLE IF NOT EXISTS firmware_builds(id TEXT PRIMARY KEY,station_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL,release_id TEXT,error TEXT,log TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS telemetry_rejections(station_id TEXT NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER NOT NULL,received_at INTEGER NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(station_id,boot_id,sequence));
CREATE INDEX IF NOT EXISTS telemetry_rejection_received ON telemetry_rejections(received_at);
CREATE TABLE IF NOT EXISTS device_status(station_id TEXT PRIMARY KEY,received_at INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS station_display(station_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings_secrets(name TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_clients(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notification_state(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,next_attempt INTEGER NOT NULL,attempts INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,sent_at INTEGER,last_error TEXT,lease_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notification_pending ON notification_outbox(state,next_attempt);
CREATE TABLE IF NOT EXISTS device_log_sessions(station_id TEXT PRIMARY KEY,id TEXT NOT NULL,expires_at INTEGER NOT NULL,command_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS device_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,station_id TEXT NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER NOT NULL,received_at INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(station_id,boot_id,sequence));
CREATE INDEX IF NOT EXISTS device_logs_station ON device_logs(station_id,id);
CREATE TABLE IF NOT EXISTS certificate_renewals(station_id TEXT PRIMARY KEY,certificate_id TEXT NOT NULL,new_id TEXT,state TEXT NOT NULL,created_at INTEGER NOT NULL,command_id TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS alarm_state(station_id TEXT NOT NULL,rule_id TEXT NOT NULL,rule_hash TEXT NOT NULL,active INTEGER NOT NULL,pending_since INTEGER,clearing_since INTEGER,last_at INTEGER NOT NULL,value REAL,suspended INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(station_id,rule_id));
CREATE TABLE IF NOT EXISTS alarm_events(id INTEGER PRIMARY KEY AUTOINCREMENT,station_id TEXT NOT NULL,rule_id TEXT NOT NULL,name TEXT NOT NULL,at INTEGER NOT NULL,kind TEXT NOT NULL,value REAL,acknowledged_at INTEGER,acknowledged_by TEXT);
CREATE TABLE IF NOT EXISTS sensor_quality(station_id TEXT NOT NULL,metric TEXT NOT NULL,last_at INTEGER NOT NULL,value REAL NOT NULL,changed_at INTEGER NOT NULL,PRIMARY KEY(station_id,metric));
CREATE TABLE IF NOT EXISTS rain_increments(station_id TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,amount_mm REAL NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(station_id,end_at));
CREATE TABLE IF NOT EXISTS import_previews(id TEXT PRIMARY KEY,station_id TEXT NOT NULL,batch_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,actor TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deployment_acceptance(check_id TEXT PRIMARY KEY,configuration_hash TEXT NOT NULL,at INTEGER NOT NULL,actor TEXT NOT NULL,passed INTEGER NOT NULL,note TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS database_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,station_id TEXT NOT NULL,target_hash TEXT NOT NULL,observed_at INTEGER NOT NULL,row_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,UNIQUE(station_id,target_hash,observed_at));
CREATE INDEX IF NOT EXISTS database_outbox_pending ON database_outbox(station_id,target_hash,observed_at);
CREATE TABLE IF NOT EXISTS database_delivery(station_id TEXT NOT NULL,target_hash TEXT NOT NULL,last_queued_at INTEGER NOT NULL,last_delivered_at INTEGER,last_error TEXT,PRIMARY KEY(station_id,target_hash));
`;

export class Store {
  constructor({
    root,
    environment,
    readonly = false,
    clock = Date.now,
    journalMode = 'WAL',
    configurationDatabase,
  }) {
    if (!['development', 'production', 'test'].includes(environment)) throw new Error('Ugyldig miljø');
    if (!['WAL', 'DELETE'].includes(journalMode)) throw new Error('Ugyldig SQLite-journalmodus');
    this.environment = environment;
    this.clock = clock;
    this.root = resolve(root);
    this.readonly = readonly;
    if (!readonly) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(this.root);
    const marker = this.safe('.environment');
    if (!readonly && !existsSync(marker)) writeFileSync(marker, environment, { flag: 'wx', mode: 0o600 });
    if (readFileSync(marker, 'utf8').trim() !== environment)
      throw new Error('Datalager tilhører et annet miljø');
    const system = this.safe('system');
    if (!readonly) mkdirSync(system, { recursive: true, mode: 0o700 });
    this.db = new Database(this.safe('system', 'gateway.sqlite3'), { readonly, fileMustExist: readonly });
    this.db.pragma('busy_timeout = 10000');
    this.db.pragma('foreign_keys = ON');
    if (!readonly) {
      const actualJournal = this.db.pragma(`journal_mode = ${journalMode}`, { simple: true });
      if (actualJournal !== journalMode.toLowerCase())
        throw new Error('SQLite-journalmodus kunne ikke aktiveres');
      this.db.pragma('synchronous = FULL');
      this.db.exec(schema);
      if (configurationDatabase) {
        try {
          this.db = new ConfigurationDatabase(this.db, configurationDatabase, environment);
        } catch (error) {
          this.db.close();
          throw error;
        }
      }
      if (!this.db.pragma('table_info(commands)').some((c) => c.name === 'sequence'))
        this.db.exec('ALTER TABLE commands ADD COLUMN sequence INTEGER');
      this.db.exec('UPDATE commands SET sequence=rowid WHERE sequence IS NULL');
      this.db
        .prepare("INSERT OR IGNORE INTO meta VALUES ('command_sequence',?)")
        .run(String(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM commands').get().seq));
      for (const [key, value] of [
        ['version', '1'],
        ['environment', environment],
      ]) {
        this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run(key, value);
        if (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value !== value)
          throw new Error('Inkompatibelt datalager');
      }
      this.sweep();
    }
    if (this.db.prepare("SELECT value FROM meta WHERE key='environment'").get()?.value !== environment)
      throw new Error('Databasen tilhører et annet miljø');
  }
  safe(...parts) {
    let path = this.root;
    for (const part of parts) {
      path = join(path, part);
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error('Symbolske lenker er ikke tillatt i datalageret');
    }
    const rel = relative(this.root, resolve(path));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Ugyldig filsti');
    return path;
  }
  stationDirectory(stationId, child = 'exports') {
    id.parse(stationId);
    if (!['exports', 'raw', 'reports', 'diagnostics', 'firmware'].includes(child))
      throw new Error('Ugyldig mappe');
    mkdirSync(this.safe('stations', stationId), { recursive: true, mode: 0o750 });
    const p = this.safe('stations', stationId, child);
    mkdirSync(p, { recursive: true, mode: child === 'exports' || child === 'reports' ? 0o750 : 0o700 });
    return p;
  }
  close() {
    this.db.close();
  }
  audit(actor, action, details = {}) {
    this.db
      .prepare('INSERT INTO audit(at,actor,action,details) VALUES (?,?,?,?)')
      .run(this.clock(), actor, action, JSON.stringify(details));
  }
  events(limit = 200) {
    return this.db
      .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((x) => ({ ...x, details: JSON.parse(x.details) }));
  }
  initialize(scope, payload) {
    payload = validateScope(scope, payload);
    const result = this.db
      .prepare('INSERT OR IGNORE INTO configuration VALUES (?,1,?)')
      .run(scope, JSON.stringify(payload));
    if (result.changes) this.audit('bootstrap', 'initialize', { scope, hash: hash(payload) });
  }
  current(scope) {
    const r = this.db.prepare('SELECT * FROM configuration WHERE scope=?').get(scope);
    if (!r) fail('Konfigurasjonen finnes ikke', 404);
    return { scope, revision: r.revision, value: JSON.parse(r.payload) };
  }
  confirmedValue(scope) {
    return this.confirmedConfiguration(scope).value;
  }
  confirmedConfiguration(scope) {
    const trial = this.db
      .prepare(
        "SELECT before_json,base_revision FROM changes WHERE scope=? AND state IN ('testing','confirming')",
      )
      .get(scope);
    return trial
      ? { scope, revision: trial.base_revision, value: JSON.parse(trial.before_json) }
      : this.current(scope);
  }
  configurations(prefix = '') {
    return this.db
      .prepare('SELECT * FROM configuration WHERE scope LIKE ? ORDER BY scope')
      .all(`${prefix}%`)
      .map((r) => ({ scope: r.scope, revision: r.revision, value: JSON.parse(r.payload) }));
  }
  change(row) {
    return (
      row && {
        ...row,
        before: JSON.parse(row.before_json),
        candidate: JSON.parse(row.candidate_json),
        health: row.health_json ? JSON.parse(row.health_json) : null,
        before_json: undefined,
        candidate_json: undefined,
        health_json: undefined,
      }
    );
  }
  changes() {
    return this.db
      .prepare('SELECT * FROM changes ORDER BY created_at DESC LIMIT 100')
      .all()
      .map((r) => this.change(r));
  }
  getChange(changeId) {
    const c = this.change(this.db.prepare('SELECT * FROM changes WHERE id=?').get(changeId));
    if (!c) fail('Endringen finnes ikke', 404);
    return c;
  }
  propose(scope, candidate, baseRevision, actor) {
    this.sweep();
    candidate = validateScope(scope, candidate);
    if (
      scope === 'gateway' &&
      this.environment === 'production' &&
      new URL(candidate.adminOrigin).protocol !== 'https:'
    )
      fail('Produksjon krever HTTPS-adresse', 400);
    return this.db
      .transaction(() => {
        const current = this.current(scope);
        if (
          scope.startsWith('device:') &&
          this.db
            .prepare("SELECT 1 FROM changes WHERE scope=? AND state IN ('draft','testing','confirming')")
            .get(`firmware:${scope.slice(7)}`)
        )
          fail('Avslutt firmwaretesten før du endrer enhetsinnstillingene');
        if (current.revision !== baseRevision) fail('Konfigurasjonen er endret. Last inn på nytt.');
        if (
          this.db
            .prepare("SELECT 1 FROM changes WHERE scope=? AND state IN ('draft','testing','confirming')")
            .get(scope)
        )
          fail('Det finnes allerede en åpen endring');
        if (
          scope.startsWith('station:') &&
          this.configurations('station:').some((s) => s.scope !== scope && s.value.key === candidate.key)
        )
          fail('Publiseringsnøkkelen er allerede i bruk');
        const cid = randomUUID();
        this.db
          .prepare(
            "INSERT INTO changes(id,scope,base_revision,before_json,candidate_json,state,created_at,actor) VALUES (?,?,?,?,?,'draft',?,?)",
          )
          .run(
            cid,
            scope,
            current.revision,
            JSON.stringify(current.value),
            JSON.stringify(candidate),
            this.clock(),
            actor,
          );
        this.audit(actor, 'propose', { changeId: cid, scope, hash: hash(candidate) });
        return this.getChange(cid);
      })
      .immediate();
  }
  timeoutSeconds() {
    const trial = this.db
      .prepare("SELECT before_json FROM changes WHERE scope='gateway' AND state IN ('testing','confirming')")
      .get();
    return trial
      ? JSON.parse(trial.before_json).confirmationSeconds
      : this.current('gateway').value.confirmationSeconds;
  }
  begin(changeId, actor) {
    this.sweep();
    return this.db
      .transaction(() => {
        const c = this.getChange(changeId);
        if (c.state !== 'draft') fail('Bare et utkast kan testes');
        const previousTime = Number(
          this.db.prepare("SELECT value FROM meta WHERE key='clock'").get()?.value || 0,
        );
        if (this.clock() < previousTime) fail('Systemklokken må synkroniseres før nye tester');
        if (this.current(c.scope).revision !== c.base_revision) fail('Utgangspunktet er endret');
        const deadline = this.clock() + this.timeoutSeconds() * 1000;
        this.db
          .prepare('UPDATE configuration SET payload=?,revision=revision+1 WHERE scope=?')
          .run(JSON.stringify(c.candidate), c.scope);
        this.db.prepare("UPDATE changes SET state='testing',deadline=? WHERE id=?").run(deadline, c.id);
        if (c.scope.startsWith('device:'))
          this.queueCommand(
            c.scope.slice(7),
            'test_config',
            { configuration: c.candidate, configurationHash: hash(c.candidate) },
            deadline,
            c.id,
          );
        this.audit(actor, 'test', { changeId, deadline });
        if (c.scope.startsWith('firmware:')) {
          if (
            this.db
              .prepare("SELECT 1 FROM changes WHERE scope=? AND state IN ('draft','testing','confirming')")
              .get(`device:${c.candidate.stationId}`)
          )
            fail('Avslutt enhetstesten før firmwareoppdatering');
          const build = this.db
            .prepare("SELECT payload FROM firmware_builds WHERE release_id=? AND state='ready'")
            .get(c.candidate.releaseId);
          if (build) {
            const p = JSON.parse(build.payload);
            if (hash(this.confirmedValue(`device:${c.candidate.stationId}`)) !== p.baseHash)
              fail('Enhetsinnstillingene er endret. Bygg firmware på nytt.');
          }
          const release = this.db
            .prepare('SELECT * FROM firmware_releases WHERE id=? AND station_id=?')
            .get(c.candidate.releaseId, c.candidate.stationId);
          if (!release) fail('Firmwareutgivelsen finnes ikke', 404);
          this.queueCommand(
            c.candidate.stationId,
            'test_firmware',
            { releaseId: release.id, manifest: JSON.parse(release.manifest), signature: release.signature },
            deadline,
            c.id,
          );
        }
        return this.getChange(changeId);
      })
      .immediate();
  }
  health(changeId, healthy, report) {
    this.sweep();
    const c = this.getChange(changeId);
    if (!['testing', 'confirming'].includes(c.state)) fail('Testen er ikke aktiv');
    if (!healthy) return this.rollback(changeId, 'health_failed', 'probe');
    this.db
      .prepare('UPDATE changes SET health_json=? WHERE id=?')
      .run(JSON.stringify({ at: this.clock(), ...report }), changeId);
    this.audit('probe', 'health', { changeId });
    return this.getChange(changeId);
  }
  confirm(changeId, actor) {
    this.sweep();
    return this.db
      .transaction(() => {
        const c = this.getChange(changeId);
        if (c.state !== 'testing' || !c.health || this.clock() - c.health.at > 30000)
          fail('Endringen må ha en fersk, vellykket helsesjekk');
        if (c.scope.startsWith('device:') && (!c.health.deviceAck || !c.health.deviceTelemetry))
          fail('Enheten må kvittere og sende gyldige målinger med testinnstillingene');
        if (c.scope.startsWith('firmware:') && (!c.health.firmwareAck || !c.health.firmwareTelemetry))
          fail('Den nye firmwaren må kvittere og sende gyldige sensormålinger');
        if (c.scope.startsWith('firmware:')) {
          this.queueCommand(
            c.candidate.stationId,
            'commit_firmware',
            { releaseId: c.candidate.releaseId },
            c.deadline,
            c.id,
          );
          this.db.prepare("UPDATE changes SET state='confirming' WHERE id=?").run(c.id);
        } else if (c.scope.startsWith('device:')) {
          this.queueCommand(
            c.scope.slice(7),
            'commit_config',
            { configurationHash: hash(c.candidate) },
            c.deadline,
            c.id,
          );
          this.db.prepare("UPDATE changes SET state='confirming' WHERE id=?").run(c.id);
        } else this.db.prepare("UPDATE changes SET state='confirmed' WHERE id=?").run(c.id);
        this.audit(actor, 'confirm', { changeId });
        if (c.scope.startsWith('station:'))
          this.db.prepare('DELETE FROM sensor_quality WHERE station_id=?').run(c.candidate.id);
        return this.getChange(changeId);
      })
      .immediate();
  }
  rollback(changeId, reason = 'cancelled', actor = 'system') {
    return this.db
      .transaction(() => {
        const c = this.getChange(changeId);
        if (!['draft', 'testing', 'confirming'].includes(c.state)) fail('Endringen er avsluttet');
        if (c.state !== 'draft') {
          this.db
            .prepare('UPDATE configuration SET payload=?,revision=revision+1 WHERE scope=?')
            .run(JSON.stringify(c.before), c.scope);
          if (c.scope.startsWith('device:'))
            this.queueCommand(
              c.scope.slice(7),
              'rollback_config',
              { configurationHash: hash(c.candidate) },
              this.clock() + 300000,
              c.id,
            );
        }
        if (c.scope.startsWith('firmware:') && c.state !== 'draft')
          this.queueCommand(
            c.candidate.stationId,
            'rollback_firmware',
            { releaseId: c.candidate.releaseId },
            this.clock() + 300000,
            c.id,
          );
        this.db.prepare("UPDATE changes SET state='rolled_back',reason=? WHERE id=?").run(reason, c.id);
        this.db
          .prepare(
            "UPDATE commands SET state='cancelled' WHERE change_id=? AND kind NOT IN ('rollback_config','rollback_firmware') AND state IN ('queued','sent','received','testing')",
          )
          .run(c.id);
        this.audit(actor, 'rollback', { changeId, reason });
        return this.getChange(changeId);
      })
      .immediate();
  }
  sweep() {
    if (this.readonly) return;
    return this.db
      .transaction(() => {
        const now = this.clock(),
          previous = Number(this.db.prepare("SELECT value FROM meta WHERE key='clock'").get()?.value || 0);
        for (const c of this.db
          .prepare("SELECT id,deadline FROM changes WHERE state IN ('testing','confirming')")
          .all())
          if (now >= c.deadline || now < previous)
            this.rollback(c.id, now < previous ? 'clock_regressed' : 'timeout');
        this.db
          .prepare("INSERT INTO meta VALUES ('clock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(String(Math.max(now, previous)));
        this.db
          .prepare(
            "UPDATE commands SET state='expired' WHERE deadline<=? AND state IN ('queued','sent','received')",
          )
          .run(now);
        this.db.prepare('DELETE FROM sessions WHERE last_at<?').run(now - 86400000);
      })
      .immediate();
  }
  queueCommand(stationId, kind, payload, deadline, changeId = null) {
    return this.db
      .transaction(() => {
        // MariaDB 11.x does not support UPDATE ... RETURNING. Both operations
        // remain under the same SQLite write lock / MariaDB transaction lock.
        this.db.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='command_sequence'").run();
        const sequence = Number(
          this.db.prepare("SELECT value FROM meta WHERE key='command_sequence'").get().value,
        );
        const commandId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO commands(id,station_id,kind,payload,created_at,deadline,state,change_id,sequence) VALUES (?,?,?,?,?,?,'queued',?,?)",
          )
          .run(
            commandId,
            stationId,
            kind,
            JSON.stringify(payload),
            this.clock(),
            deadline,
            changeId,
            sequence,
          );
        return commandId;
      })
      .immediate();
  }
  commandList() {
    return this.db
      .prepare(
        'SELECT id,station_id,kind,created_at,deadline,state,change_id,ack_json FROM commands ORDER BY created_at DESC LIMIT 100',
      )
      .all();
  }
  stationList() {
    return this.configurations('station:');
  }
  checkpoint() {
    this.db.pragma('wal_checkpoint(PASSIVE)');
  }
}
