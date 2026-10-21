import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, observation, directory, approvePublicToken } from './helpers.js';
import { ingest } from '../server/observations.js';
import { durableTelemetryReceipt } from '../server/worker.js';
import { controlApp, publicApp } from '../server/app.js';
import { recentPackets } from '../server/raw-packets.js';

const packet = '8004700f99009111ffff';
const source = () => ({
  protocol: 'davis-iss',
  packet: Buffer.from(packet, 'hex').toString('base64'),
  channel: 3,
  rssiDbm: -63,
});
test('raw packet window follows gateway receive time, keeps decoded bytes and excludes expired packets and contact messages', (t) => {
  const { store, now, tick } = setup(t),
    station = store.stationList()[0].value;
  ingest(store, station.id, observation(station.id, now(), { source: source() }));
  tick(59999);
  ingest(store, station.id, observation(station.id, now() - 3600000, { sequence: 2, source: source() }));
  ingest(
    store,
    station.id,
    observation(station.id, now(), { sequence: 3, sensorContact: false, measurements: {} }),
  );
  let result = recentPackets(store, station.id);
  assert.equal(result.windowSeconds, 60);
  assert.equal(result.packets.length, 2);
  assert.equal(result.packets[0].sequence, 2);
  assert.equal(result.packets[0].hex, '80 04 70 0F 99 00 91 11 FF FF');
  assert.deepEqual(result.packets[0].bytes, [128, 4, 112, 15, 153, 0, 145, 17, 255, 255]);
  assert.equal(result.packets[0].checksum, 'valid');
  assert.equal(result.packets[0].channel, 4);
  assert.equal(result.packets[0].rawWindDirectionByte, 112);
  assert.equal(result.packets[0].measurements.windSpeedMs, 1.78816);
  tick(1);
  result = recentPackets(store).packets;
  assert.equal(result.length, 1);
  assert.equal(result[0].sequence, 2);
  tick(60000);
  assert.equal(recentPackets(store).packets.length, 0);
});
test('rejected MQTT Davis packets remain inspectable without exposing arbitrary payload or credentials', (t) => {
  const { store, now } = setup(t),
    station = store.stationList()[0].value;
  const invalid = source();
  invalid.packet = Buffer.from(packet.replace('9111', '9110'), 'hex').toString('base64');
  const body = observation(station.id, now(), { source: invalid });
  const result = durableTelemetryReceipt(store, station.id, Buffer.from(JSON.stringify(body)));
  assert.equal(result.status, 'rejected');
  const raw = recentPackets(store).packets;
  assert.equal(raw.length, 1);
  assert.equal(raw[0].status, 'rejected');
  assert.equal(raw[0].checksum, 'invalid');
  store.db
    .prepare('UPDATE telemetry_rejections SET payload=?')
    .run(
      JSON.stringify({
        ...body,
        password: 'do-not-return',
        wifi: { password: 'secret' },
        environment: { LDAP_PASSWORD: 'secret' },
      }),
    );
  assert.doesNotMatch(JSON.stringify(recentPackets(store)), /do-not-return|password|LDAP_PASSWORD/);
  store.db.prepare('UPDATE telemetry_rejections SET payload=?').run('{bad json');
  assert.equal(recentPackets(store).packets.length, 0);
});
test('raw packet API requires AD session, supports station filtering and is absent from public service', async (t) => {
  const { store, config, now } = setup(t),
    station = store.stationList()[0].value;
  ingest(store, station.id, observation(station.id, now(), { source: source() }));
  const { app } = controlApp({ store, config, directory: directory(['viewer']) });
  await request(app).get('/api/packets').expect(401);
  const agent = request.agent(app);
  await agent
    .post('/api/login')
    .set('Origin', config.defaults.adminOrigin)
    .send({ username: 'test', password: 'valid-test-password' })
    .expect(200);
  const all = await agent.get('/api/packets').expect(200);
  assert.equal(all.body.packets.length, 1);
  await agent.get('/api/packets?stationId=invalid').expect(400);
  await agent.get('/api/packets?limit=999999').expect(400);
  const other = store.stationList().find((s) => s.value.id !== station.id).value.id;
  const filtered = await agent.get(`/api/packets?stationId=${other}`).expect(200);
  assert.equal(filtered.body.packets.length, 0);
  const selected = await agent.get(`/api/packets?stationId=${station.id}`).expect(200);
  assert.equal(selected.body.packets[0].stationId, station.id);
  config.publicToken = 'p'.repeat(40);
  approvePublicToken(store, config, config.publicToken);
  await request(publicApp({ store, config }).app)
    .get('/api/packets')
    .set('Authorization', `Bearer ${config.publicToken}`)
    .expect(404);
});
test('raw packet result has a bounded size and stable newest-first ordering', (t) => {
  const { store, now } = setup(t),
    station = store.stationList()[0].value;
  const insert = store.db.prepare('INSERT INTO observations VALUES (?,?,?,?,?,?)');
  store.db.transaction(() => {
    for (let seq = 1; seq <= 510; seq++)
      insert.run(
        station.id,
        'fixture',
        seq,
        now(),
        now(),
        JSON.stringify({ source: source(), measurements: { windSpeedMs: 4, windDirectionDeg: 270 } }),
      );
  })();
  const result = recentPackets(store);
  assert.equal(result.packets.length, 500);
  assert.equal(result.truncated, true);
  assert.equal(result.packets[0].sequence, 510);
  assert.equal(result.packets.at(-1).sequence, 11);
});
