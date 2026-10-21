import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { firmwareManifestSchema, id } from './schema.js';
import { Rejected, hash } from './store.js';

export const manifestBytes = (m) =>
  Buffer.from(
    `${m.format}\n${m.stationId}\n${m.environment}\n${m.version}\n${m.sequence}\n${m.size}\n${m.sha256}\n`,
    'utf8',
  );
export function firmwarePublicKey(path) {
  const key = createPublicKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1')
    throw new Rejected('Firmware krever en ECDSA P-256-verifikasjonsnøkkel', 503);
  return key;
}
export function uploadFirmware(store, config, input, actor) {
  if (!config.firmwarePublicKeyFile)
    throw new Rejected('Firmware-verifikasjonsnøkkelen er ikke konfigurert', 503);
  const release = z
    .object({
      manifest: firmwareManifestSchema,
      signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
      image: z
        .string()
        .min(4)
        .max(2097152)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict()
    .parse(input);
  const m = release.manifest,
    image = Buffer.from(release.image, 'base64');
  store.current(`station:${m.stationId}`);
  if (m.environment !== store.environment) throw new Rejected('Firmware er signert for et annet miljø', 400);
  if (
    image.length !== m.size ||
    createHash('sha256').update(image).digest('hex') !== m.sha256 ||
    image[0] !== 0xe9
  )
    throw new Rejected('Firmwarebildet stemmer ikke med manifestet', 400);
  if (
    !verify(
      'sha256',
      manifestBytes(m),
      { key: firmwarePublicKey(config.firmwarePublicKeyFile), dsaEncoding: 'ieee-p1363' },
      Buffer.from(release.signature, 'base64'),
    )
  )
    throw new Rejected('Ugyldig firmwaresignatur', 400);
  const existing = store.db
    .prepare('SELECT id FROM firmware_releases WHERE station_id=? AND manifest=?')
    .get(m.stationId, JSON.stringify(m));
  if (existing) return { releaseId: existing.id, manifest: m };
  const releaseId = randomUUID(),
    directory = store.stationDirectory(m.stationId, 'firmware'),
    target = join(directory, `${releaseId}.bin`),
    fd = openSync(`${target}.tmp`, 'wx', 0o600);
  try {
    writeSync(fd, image);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${target}.tmp`, target);
  store.db
    .prepare('INSERT INTO firmware_releases VALUES (?,?,?,?,?)')
    .run(releaseId, m.stationId, JSON.stringify(m), release.signature, store.clock());
  store.audit(actor, 'firmware_uploaded', {
    releaseId,
    stationId: m.stationId,
    sha256: m.sha256,
    version: m.version,
    sequence: m.sequence,
  });
  return { releaseId, manifest: m };
}
export function firmwareReleases(store) {
  return store.db
    .prepare(
      "SELECT r.id,r.station_id,r.manifest,r.created_at,COALESCE(json_extract(b.payload,'$.purpose'),'ota') AS installation FROM firmware_releases r LEFT JOIN firmware_builds b ON b.release_id=r.id WHERE b.state IS NULL OR b.state NOT IN ('deleted','deleting') ORDER BY r.created_at DESC LIMIT 100",
    )
    .all()
    .map((r) => ({ ...r, manifest: JSON.parse(r.manifest) }));
}
export function proposeFirmware(store, releaseId, actor) {
  const release = store.db.prepare('SELECT * FROM firmware_releases WHERE id=?').get(id.parse(releaseId));
  if (!release) throw new Rejected('Utgivelsen finnes ikke', 404);
  if (
    store.db
      .prepare("SELECT 1 FROM firmware_builds WHERE release_id=? AND state IN ('deleted','deleting')")
      .get(release.id)
  )
    throw new Rejected('Bygget er slettet fra serveren', 404);
  const build = store.db
    .prepare("SELECT payload FROM firmware_builds WHERE release_id=? AND state='ready'")
    .get(release.id);
  if (build) {
    const payload = JSON.parse(build.payload);
    if (
      !store.db
        .prepare(
          'SELECT 1 FROM certificates WHERE id=? AND station_id=? AND revoked_at IS NULL AND expires_at>?',
        )
        .get(payload.certificateId, release.station_id, store.clock())
    )
      throw new Rejected('Byggets enhetssertifikat er utløpt eller tilbakekalt. Bygg firmware på nytt.');
    if (payload.purpose !== 'ota')
      throw new Rejected('Dette bygget er laget for USB. Velg nettverksoppdatering og bygg på nytt.');
    if (hash(store.confirmedValue(`device:${release.station_id}`)) !== payload.baseHash)
      throw new Rejected('Enhetsinnstillingene er endret. Bygg firmware på nytt.');
  }
  const scope = `firmware:${release.station_id}`;
  store.initialize(scope, { stationId: release.station_id, releaseId: null });
  const current = store.current(scope),
    active =
      current.value.releaseId &&
      store.db.prepare('SELECT manifest FROM firmware_releases WHERE id=?').get(current.value.releaseId);
  if (active && JSON.parse(active.manifest).sequence >= JSON.parse(release.manifest).sequence)
    throw new Rejected('Utgivelsessekvensen må være høyere enn gjeldende firmware');
  if (
    store
      .changes()
      .some(
        (c) =>
          ['draft', 'testing', 'confirming'].includes(c.state) && c.scope === `device:${release.station_id}`,
      )
  )
    throw new Rejected('Avslutt enhetstesten før firmwareoppdatering');
  return store.propose(
    scope,
    { stationId: release.station_id, releaseId: release.id },
    current.revision,
    actor,
  );
}
export function firmwareChunk(store, stationId, input) {
  const request = z
    .object({
      version: z.literal(1),
      commandId: id,
      releaseId: id,
      offset: z.number().int().nonnegative().max(0x180000),
    })
    .strict()
    .parse(input);
  const command = store.db
    .prepare(
      "SELECT commands.* FROM commands JOIN changes ON changes.id=commands.change_id WHERE commands.id=? AND commands.station_id=? AND kind='test_firmware' AND commands.deadline>? AND changes.state IN ('testing','confirming') AND commands.state IN ('queued','sent','received','testing')",
    )
    .get(request.commandId, stationId, store.clock());
  if (!command || JSON.parse(command.payload).releaseId !== request.releaseId)
    throw new Rejected('Firmwaretesten er ikke aktiv', 403);
  const release = store.db
      .prepare('SELECT * FROM firmware_releases WHERE id=? AND station_id=?')
      .get(request.releaseId, stationId),
    manifest = JSON.parse(release.manifest);
  if (request.offset >= manifest.size || request.offset % 1024)
    throw new Rejected('Ugyldig firmwareposisjon', 400);
  const fd = openSync(store.safe('stations', stationId, 'firmware', `${release.id}.bin`), 'r'),
    buffer = Buffer.alloc(Math.min(1024, manifest.size - request.offset));
  try {
    if (readSync(fd, buffer, 0, buffer.length, request.offset) !== buffer.length)
      throw new Error('Firmwarefilen er avkortet');
  } finally {
    closeSync(fd);
  }
  return {
    version: 1,
    commandId: request.commandId,
    releaseId: release.id,
    offset: request.offset,
    data: buffer.toString('base64'),
  };
}
