import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, observation } from './helpers.js';
import { ingest } from '../server/observations.js';
import { manifestBytes, uploadFirmware, proposeFirmware, firmwareChunk } from '../server/firmware-updates.js';
import { handleAck, firmwareHealth } from '../server/worker.js';

function release(t) {
  const state = setup(t),
    stationId = state.store.stationList()[0].value.id;
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyFile = join(state.store.root, 'firmware-signing-public.pem');
  writeFileSync(keyFile, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const image = Buffer.alloc(3072, 42);
  image[0] = 0xe9;
  const manifest = {
    format: 'wg-firmware-1',
    stationId,
    environment: 'test',
    version: '2.0.0',
    sequence: 1,
    size: image.length,
    sha256: createHash('sha256').update(image).digest('hex'),
  };
  const input = {
    manifest,
    signature: sign('sha256', manifestBytes(manifest), {
      key: pair.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64'),
    image: image.toString('base64'),
  };
  const config = { ...state.config, firmwarePublicKeyFile: keyFile };
  return { ...state, stationId, input, config, image, pair };
}
test('signed firmware is bound to exact bytes, station, environment and version; foreign or altered releases are rejected', (t) => {
  const s = release(t);
  const result = uploadFirmware(s.store, s.config, s.input, 'admin');
  assert.equal(uploadFirmware(s.store, s.config, s.input, 'admin').releaseId, result.releaseId);
  assert.throws(
    () =>
      uploadFirmware(
        s.store,
        s.config,
        { ...s.input, manifest: { ...s.input.manifest, environment: 'production' } },
        'admin',
      ),
    /miljø/,
  );
  assert.throws(
    () =>
      uploadFirmware(
        s.store,
        s.config,
        { ...s.input, manifest: { ...s.input.manifest, version: '3.0.0' } },
        'admin',
      ),
    /signatur/,
  );
  const altered = Buffer.from(s.image);
  altered[1] ^= 1;
  assert.throws(
    () => uploadFirmware(s.store, s.config, { ...s.input, image: altered.toString('base64') }, 'admin'),
    /manifest/,
  );
  assert.throws(
    () =>
      firmwareChunk(s.store, s.stationId, {
        version: 1,
        releaseId: result.releaseId,
        commandId: '402500fa-a03b-4dcf-af73-11109f9b8329',
        offset: 0,
      }),
    /ikke aktiv/,
  );
});
test('OTA requires fresh measurements from the tested release and commit ACK, with bounded station-specific chunk access', (t) => {
  const s = release(t),
    uploaded = uploadFirmware(s.store, s.config, s.input, 'admin');
  const draft = proposeFirmware(s.store, uploaded.releaseId, 'admin');
  s.store.begin(draft.id, 'admin');
  const command = s.store.db.prepare("SELECT * FROM commands WHERE kind='test_firmware'").get();
  const chunk = firmwareChunk(s.store, s.stationId, {
    version: 1,
    commandId: command.id,
    releaseId: uploaded.releaseId,
    offset: 1024,
  });
  assert.deepEqual(Buffer.from(chunk.data, 'base64'), s.image.subarray(1024, 2048));
  assert.throws(
    () =>
      firmwareChunk(s.store, s.stationId, {
        version: 1,
        commandId: command.id,
        releaseId: uploaded.releaseId,
        offset: 1,
      }),
    /posisjon/,
  );
  const other = s.store.stationList()[1].value.id;
  assert.throws(
    () =>
      firmwareChunk(s.store, other, {
        version: 1,
        commandId: command.id,
        releaseId: uploaded.releaseId,
        offset: 0,
      }),
    /ikke aktiv/,
  );
  assert.throws(() => s.store.confirm(draft.id, 'admin'), /helsesjekk/);
  handleAck(s.store, s.stationId, {
    version: 1,
    stationId: s.stationId,
    commandId: command.id,
    status: 'testing',
    firmwareReleaseId: uploaded.releaseId,
  });
  assert.equal(firmwareHealth(s.store, s.stationId), false);
  ingest(s.store, s.stationId, observation(s.stationId, s.now(), { firmwareReleaseId: uploaded.releaseId }));
  assert.equal(firmwareHealth(s.store, s.stationId), true);
  assert.equal(s.store.confirm(draft.id, 'admin').state, 'confirming');
  const commit = s.store.db.prepare("SELECT * FROM commands WHERE kind='commit_firmware'").get();
  handleAck(s.store, s.stationId, {
    version: 1,
    stationId: s.stationId,
    commandId: commit.id,
    status: 'applied',
    firmwareReleaseId: uploaded.releaseId,
  });
  assert.equal(s.store.getChange(draft.id).state, 'confirmed');
  assert.throws(() => proposeFirmware(s.store, uploaded.releaseId, 'admin'), /sekvens/);
});
test('unconfirmed OTA times out to the previous release and stops serving image chunks', (t) => {
  const s = release(t),
    uploaded = uploadFirmware(s.store, s.config, s.input, 'admin');
  const draft = proposeFirmware(s.store, uploaded.releaseId, 'admin');
  s.store.begin(draft.id, 'admin');
  const command = s.store.db.prepare("SELECT * FROM commands WHERE kind='test_firmware'").get();
  s.tick(300001);
  s.store.sweep();
  assert.equal(s.store.getChange(draft.id).state, 'rolled_back');
  assert.equal(s.store.current(`firmware:${s.stationId}`).value.releaseId, null);
  assert.equal(
    s.store.db.prepare("SELECT state FROM commands WHERE kind='rollback_firmware'").get().state,
    'queued',
  );
  assert.throws(
    () =>
      firmwareChunk(s.store, s.stationId, {
        version: 1,
        commandId: command.id,
        releaseId: uploaded.releaseId,
        offset: 0,
      }),
    /ikke aktiv/,
  );
});
