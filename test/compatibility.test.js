import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { setup, observation, approvePublicToken } from './helpers.js';
import { ingest, periodReport, dailyStatistics, history } from '../server/observations.js';
import { publicApp } from '../server/app.js';
import { trendFromPoints } from '../server/legacy-sockets.js';
import { astronomy } from '../server/astronomy.js';
import { wetBulb } from '../server/meteo.js';
import { startBackup, listBackups, finishBackups } from '../server/backups.js';
import { maintain } from '../server/maintenance.js';
import Database from 'better-sqlite3';
import { publicProjection } from '../server/public-projection.js';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.js';

test('nye observasjoner oppdaterer ekstremer og månedsrapport; reset av regnteller mister ikke tidligere regn', (t) => {
  const { store, now, tick } = setup(t),
    s = store.stationList()[0].value;
  ingest(store, s.id, observation(s.id, now()));
  assert.equal(dailyStatistics(store, s.id).temperatureC_MAX, 20);
  tick(2000);
  ingest(
    store,
    s.id,
    observation(s.id, now(), { sequence: 2, measurements: { temperatureC: 25, rainTodayMm: 0 } }),
  );
  tick(2000);
  ingest(
    store,
    s.id,
    observation(s.id, now(), { sequence: 3, measurements: { temperatureC: 15, rainTodayMm: 0.2 } }),
  );
  const day = periodReport(store, s.id, '2026-10').days['2026-10-19'];
  assert.equal(day.temperatureC.max, 25);
  assert.equal(day.temperatureC.min, 15);
  assert.equal(day.temperatureC.mean, 20);
  assert.equal(day.rainfallMm, 3.6);
  assert.equal(day.counterResets, 1);
  assert.equal(dailyStatistics(store, s.id).temperatureC_MAX, 25);
  assert.equal(history(store, s.id, '2026-10-19').summary.samples, 3);
  assert.equal(history(store, s.id, '2026-10-19').summary.lastAt, now());
});
test('trykktrend bruker tre timers regresjon og krever tilstrekkelig dekning', () => {
  const points = Array.from({ length: 13 }, (_, i) => ({ at: i * 15 * 60000, value: 1000 + i / 4 }));
  assert.equal(trendFromPoints(points, 'barometer'), 'up');
  assert.equal(trendFromPoints(points.slice(4), 'barometer'), 'flat');
  assert.equal(
    trendFromPoints(
      [
        { at: 0, value: null },
        { at: 1000, value: 0 },
      ],
      'temperature',
    ),
    'flat',
  );
});
test('offentlig Socket.IO bevarer hendelser og avviser feil token uten administrasjonskanal', async (t) => {
  const { store, config, now } = setup(t),
    s = store.stationList()[0].value;
  ingest(store, s.id, observation(s.id, now()));
  approvePublicToken(store, config, 'x'.repeat(40));
  const service = publicApp({ store, config: { ...config, role: 'public', publicToken: 'x'.repeat(40) } }),
    server = createServer(service.app),
    stop = service.attachSockets(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const bad = io(url, { auth: { token: 'wrong' }, transports: ['websocket'], reconnection: false });
  await once(bad, 'connect_error');
  bad.disconnect();
  const socket = io(url, {
    autoConnect: false,
    auth: { token: 'x'.repeat(40) },
    transports: ['websocket'],
    reconnection: false,
  });
  t.after(() => {
    socket.disconnect();
    stop();
    server.close();
  });
  const initial = once(socket, 'file-content'),
    trends = once(socket, 'trend_snapshot');
  socket.connect();
  assert.equal((await initial)[0][s.key].temp, '20.0');
  assert.equal(typeof (await trends)[0][s.key].temperature, 'string');
  let response = once(socket, 'trendData');
  socket.emit('fetch24HourTrend', { station: s.key, type: 'currwind' });
  const trend = (await response)[0];
  assert.equal(trend.station, s.key);
  assert.equal(trend.data[0].value, 4);
  assert.match(trend.data[0].timestamp, /Z$/);
  response = once(socket, 'trendData');
  socket.emit('fetchTrendData', { station: s.key, date: '2026-10-19' });
  const daily = (await response)[0];
  assert.equal(daily.maxGust, 7);
  assert.equal(daily.dailyRainfall, 3.4);
  assert.equal(daily.data[0].average_windspeed, 4);
  response = once(socket, 'trendData');
  socket.emit('fetch24HourTrend', { station: '__proto__', type: '__proto__' });
  assert.ok((await response)[0].error);
});
test('våttemperatur krever stasjonstrykk, og astronomi håndterer midnattssol', () => {
  assert.equal(wetBulb(20, 50, undefined), null);
  assert.ok(Math.abs(wetBulb(25, 80, 1013.25) - 22.38) < 0.15);
  const a = astronomy({ latitude: 62.50821, longitude: 6.67896, elevationM: 85 }, '2026-10-19');
  assert.ok(a.sunrise < a.sunset);
  assert.ok(a.moonIlluminatedFraction >= 0 && a.moonIlluminatedFraction <= 1);
  const polar = astronomy({ latitude: 78.2, longitude: 15.6, elevationM: 0 }, '2026-06-21');
  assert.equal(polar.sunrise, null);
  assert.equal(polar.sunset, null);
});
test('online sikkerhetskopi inneholder en konsistent database med kontrollsum', async (t) => {
  const { store, now } = setup(t),
    s = store.stationList()[0].value;
  ingest(store, s.id, observation(s.id, now()));
  const task = startBackup(store, 'test');
  assert.throws(() => startBackup(store, 'other'));
  await finishBackups(store);
  const result = listBackups(store).find((b) => b.id === task.id);
  assert.equal(result.state, 'complete');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const backup = new Database(store.safe('system', 'backups', `${task.id}.sqlite3`), { readonly: true });
  try {
    assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
  } finally {
    backup.close();
  }
});
test('retensjon fjerner råobservasjoner og beholder klimatiske døgnaggregater', (t) => {
  const { store, now, tick } = setup(t),
    s = store.stationList()[0].value;
  ingest(store, s.id, observation(s.id, now()));
  tick(366 * 86400000);
  assert.equal(maintain(store, { pruneRaw: true }).observationsRemoved, 1);
  assert.equal(periodReport(store, s.id, '2026-10').days['2026-10-19'].temperatureC.mean, 20);
});
test('offentlig datakopi inneholder værdata og ingen AD-grupper, sesjoner eller kommandoer', (t) => {
  const { store, now, tick } = setup(t),
    s = store.stationList()[0].value;
  ingest(store, s.id, observation(s.id, now(), { configurationHash: 'a'.repeat(64) }));
  store.queueCommand(s.id, 'restart', {}, now() + 30000);
  const projection = publicProjection(store);
  try {
    projection.sync();
    const db = projection.store.db;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(projection.store.current('gateway').value.directory, undefined);
    assert.equal(projection.store.current('gateway').value.sessionAbsoluteHours, undefined);
    assert.equal(
      JSON.parse(db.prepare('SELECT body FROM observations').get().body).configurationHash,
      undefined,
    );
    tick(4000);
    ingest(store, s.id, observation(s.id, now(), { sequence: 2, measurements: { temperatureC: 22 } }));
    projection.sync();
    assert.equal(history(projection.store, s.id, '2026-10-19').summary.temperatureC_MAX, 22);
    tick(4 * 3600000);
    projection.sync();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 1);
  } finally {
    projection.close();
  }
});
test('offline restore verifiserer backup og kansellerer gammel autoritet', async (t) => {
  const { store } = setup(t, 'development');
  const task = startBackup(store, 'test');
  await finishBackups(store);
  const previous = store.current('gateway');
  const change = store.propose(
    'gateway',
    { ...previous.value, confirmationSeconds: 120 },
    previous.revision,
    'test',
  );
  store.begin(change.id, 'test');
  store.health(change.id, true, {});
  store.confirm(change.id, 'test');
  // Keep setup's cleanup callback valid while closing every SQLite handle for the CLI.
  const root = store.root;
  store.close();
  store.close = () => {};
  execFileSync(process.execPath, ['scripts/restore-backup.js', task.id], {
    env: {
      ...process.env,
      WG_ENVIRONMENT: 'development',
      WG_DATA_ROOT: root,
      WG_OFFLINE_RESTORE: 'services-stopped',
    },
    stdio: 'pipe',
    windowsHide: true,
  });
  const restored = new Store({ root, environment: 'development' });
  try {
    assert.equal(restored.current('gateway').value.confirmationSeconds, 300);
    assert.ok(
      Number(restored.db.prepare("SELECT value FROM meta WHERE key='command_sequence'").get().value) > 1e12,
    );
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  } finally {
    restored.close();
  }
});
test('kortere retensjon sletter ikke data før testinnstillingen er bekreftet', (t) => {
  const { store, now } = setup(t),
    s = store.stationList()[0].value;
  ingest(store, s.id, observation(s.id, now() - 100 * 86400000));
  const original = store.current('gateway');
  const change = store.propose('gateway', { ...original.value, retentionDays: 7 }, original.revision, 'test');
  store.begin(change.id, 'test');
  assert.equal(maintain(store, { pruneRaw: true }).observationsRemoved, 0);
  store.health(change.id, true, {});
  store.confirm(change.id, 'test');
  assert.equal(maintain(store, { pruneRaw: true }).observationsRemoved, 1);
});
test('datakopiens nye generasjon fjerner nyere cachedata etter restore', (t) => {
  const { store, now } = setup(t),
    s = store.stationList()[0].value;
  ingest(store, s.id, observation(s.id, now()));
  const before = publicProjection(store);
  before.sync();
  before.close();
  store.db.exec('DELETE FROM observations; DELETE FROM rollups; DELETE FROM rain_state');
  store.db.prepare("INSERT INTO meta VALUES ('projection_generation','restored')").run();
  const after = publicProjection(store);
  try {
    after.sync();
    assert.equal(after.store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 0);
    assert.equal(after.store.db.prepare('SELECT COUNT(*) AS n FROM rollups').get().n, 0);
  } finally {
    after.close();
  }
});
