import { verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { firmwarePublicKey } from './firmware-updates.js';
import { usbManifestText, validateUsbManifest } from '../shared/usb-firmware.js';
import { id } from './schema.js';
import { hash, Rejected } from './store.js';

export function verifyUsbFirmware(store, config, stationId, input, actor) {
  id.parse(stationId);
  const { manifest, signature } = z
    .object({
      manifest: z.record(z.string(), z.unknown()),
      signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    })
    .strict()
    .parse(input);
  try {
    validateUsbManifest(manifest);
  } catch {
    throw new Rejected('Ugyldig USB-pakke', 400);
  }
  if (manifest.stationId !== stationId || manifest.environment !== store.environment)
    throw new Rejected('USB-pakken gjelder en annen stasjon eller et annet miljø', 400);
  const station = store.confirmedValue(`station:${stationId}`);
  if (
    store
      .changes()
      .some(
        (c) =>
          ['draft', 'testing', 'confirming'].includes(c.state) &&
          [`device:${stationId}`, `firmware:${stationId}`].includes(c.scope),
      )
  )
    throw new Rejected('Avslutt enhets- og firmwaretester før USB-flashing');
  if (!station.enabled || station.model === 'Netatmo') throw new Rejected('Velg en aktiv ESP32-stasjon');
  if (!config.firmwarePublicKeyFile || !existsSync(config.firmwarePublicKeyFile))
    throw new Rejected('Firmware-verifikasjonsnøkkelen mangler', 503);
  if (
    !verify(
      'sha256',
      Buffer.from(usbManifestText(manifest)),
      {
        key: firmwarePublicKey(config.firmwarePublicKeyFile),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(signature, 'base64'),
    )
  )
    throw new Rejected('Ugyldig USB-signatur', 400);
  const certificate = store.db
    .prepare('SELECT 1 FROM certificates WHERE id=? AND station_id=? AND revoked_at IS NULL AND expires_at>?')
    .get(manifest.certificateId, stationId, store.clock());
  if (!certificate) throw new Rejected('Enhetssertifikatet er utløpt, tilbakekalt eller ukjent');
  const build = store.db
    .prepare(
      "SELECT payload FROM firmware_builds WHERE station_id=? AND state='ready' AND json_extract(payload,'$.configuration') IS NOT NULL",
    )
    .all(stationId)
    .map((r) => JSON.parse(r.payload))
    .find(
      (p) =>
        hash(p.configuration) === manifest.configurationHash &&
        p.certificateId === manifest.certificateId &&
        p.baseHash === hash(store.confirmedValue(`device:${stationId}`)),
    );
  if (hash(store.confirmedValue(`device:${stationId}`)) !== manifest.configurationHash && !build)
    throw new Rejected('Enhetsinnstillingene har blitt endret. Bygg en ny USB-pakke.');
  store.audit(actor, 'usb_firmware_authorized', {
    stationId,
    version: manifest.version,
    sha256: manifest.segments.at(-1).sha256,
    certificateId: manifest.certificateId,
  });
  return { verified: true, stationId, environment: store.environment, version: manifest.version };
}
