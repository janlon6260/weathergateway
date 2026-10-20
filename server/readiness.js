import { readFileSync } from 'node:fs';
import { storageHealth } from './maintenance.js';
import { databaseStatus } from './database-queue.js';
import { firmwarePublicKey } from './firmware-updates.js';
import { listBackups } from './backups.js';
import { hash } from './store.js';

export const acceptanceChecks = {
  dockerRuntime: 'Docker/Portainer: oppstart, volumer, omstart og ressursgrenser',
  externalIsolation: 'Admin er utilgjengelig fra eksternt IPv4- og IPv6-nett',
  radioReference: 'Alle fire ISS-stasjoner er sammenlignet med Davis-referanse',
  deviceRollback: 'Fysisk strømkutt, feil gateway-IP og OTA-/konfigurasjonstilbakeføring',
  restore: 'Gjenoppretting av data, enhetsidentiteter og nøkler er prøvd isolert',
  compatibility: 'Sunnmørsvær og avtalte Weather Display-utdata er sammenlignet',
};
export function deploymentFingerprint(store) {
  return hash({
    environment: store.environment,
    gateway: store.confirmedValue('gateway'),
    stations: store.stationList().map((s) => store.confirmedConfiguration(s.scope)),
    devices: store.configurations('device:').map((s) => store.confirmedConfiguration(s.scope)),
    databases: store.configurations('database:').map((s) => store.confirmedConfiguration(s.scope)),
    alarms: store.configurations('alarms:').map((s) => store.confirmedConfiguration(s.scope)),
    firmware: store.configurations('firmware:').map((s) => store.confirmedConfiguration(s.scope)),
  });
}
export function readiness(store, config) {
  const checks = [],
    add = (id, label, passed, detail) => checks.push({ id, label, passed: Boolean(passed), detail });
  const stations = store
    .stationList()
    .map((s) => store.confirmedValue(s.scope))
    .filter((s) => s.enabled && s.model !== 'Netatmo');
  add('stations', 'Minst én aktiv Davis-stasjon', stations.length > 0);
  const disk = storageHealth(store);
  add(
    'storage',
    'Skrivbart datalager med ledig plass',
    disk.writable && disk.freePercent >= 5 && disk.availableBytes >= 256 * 1024 * 1024,
    { freePercent: disk.freePercent, availableBytes: disk.availableBytes },
  );
  add(
    'configuration',
    'Ingen uavsluttede endringer',
    !store.changes().some((c) => ['draft', 'testing', 'confirming'].includes(c.state)),
  );
  let heartbeat;
  try {
    heartbeat = JSON.parse(readFileSync(store.safe('system', 'worker-heartbeat.json'), 'utf8'));
  } catch {
    /* absent worker is reported, never assumed healthy */
  }
  add(
    'worker',
    'MQTT-arbeider har fersk puls',
    heartbeat?.environment === store.environment &&
      store.clock() - heartbeat.at >= 0 &&
      store.clock() - heartbeat.at < 20000,
  );
  let trustedKey = false;
  try {
    if (config.firmwarePublicKeyFile) {
      firmwarePublicKey(config.firmwarePublicKeyFile);
      trustedKey = true;
    }
  } catch {
    /* surfaced as a failed check */
  }
  add('firmwareTrust', 'ECDSA-verifikasjonsnøkkel for firmware', trustedKey);
  const databases = databaseStatus(store);
  for (const station of stations) {
    const row = store.db
        .prepare(
          'SELECT observed_at,body FROM observations WHERE station_id=? ORDER BY observed_at DESC LIMIT 1',
        )
        .get(station.id),
      body = row ? JSON.parse(row.body) : null;
    add(
      `sensor:${station.id}`,
      `${station.name}: ferske sensordata`,
      body?.sensorContact &&
        store.clock() - row.observed_at >= -60000 &&
        store.clock() - row.observed_at < 60000,
    );
    const database = databases.find((d) => d.value.stationId === station.id);
    add(
      `database:${station.id}`,
      `${station.name}: bekreftet SQL-levering`,
      database &&
        store.confirmedValue(database.scope).enabled &&
        database.lastDeliveredAt &&
        store.clock() - database.lastDeliveredAt < 3600000 &&
        !database.lastError,
      { pending: database?.pending || 0 },
    );
    const status = store.db.prepare('SELECT * FROM device_status WHERE station_id=?').get(station.id),
      device = status ? JSON.parse(status.payload) : null;
    add(
      `spool:${station.id}`,
      `${station.name}: enhetens sendekø`,
      device &&
        store.clock() - status.received_at < 60000 &&
        device.online &&
        device.clockSynchronized &&
        device.dropped === 0,
      { pending: device?.pending, capacity: device?.capacity, dropped: device?.dropped },
    );
    add(
      `deviceSecurity:${station.id}`,
      `${station.name}: Secure Boot, flash- og NVS-kryptering`,
      device?.security?.secureBoot && device.security.flashEncryption && device.security.nvsEncryption,
      { chipRevision: device?.security?.chipRevision },
    );
  }
  add(
    'backup',
    'Nylig konsistent databasesikkerhetskopi',
    listBackups(store).some((b) => b.state === 'complete' && store.clock() - b.completedAt < 86400000),
  );
  const fingerprint = deploymentFingerprint(store),
    evidence = store.db.prepare('SELECT * FROM deployment_acceptance').all();
  for (const [id, label] of Object.entries(acceptanceChecks)) {
    const result = evidence.find(
      (r) =>
        r.check_id === id && r.configuration_hash === fingerprint && store.clock() - r.at < 30 * 86400000,
    );
    add(
      id,
      label,
      result?.passed === 1,
      result
        ? { verification: 'manual', at: result.at, actor: result.actor, note: result.note }
        : { verification: 'manual', status: 'unverified' },
    );
  }
  return {
    environment: store.environment,
    ready: store.environment === 'production' && checks.every((c) => c.passed),
    checkedAt: store.clock(),
    configurationHash: fingerprint,
    checks,
  };
}
