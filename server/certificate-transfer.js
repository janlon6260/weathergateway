import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { id } from './schema.js';
import { Rejected } from './store.js';
import { syncAcl } from './pki.js';

export const certificateTransferSchema = z
  .object({
    format: z.literal('wg-device-certificates-1'),
    environment: z.enum(['production', 'development', 'test']),
    caFingerprint: z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/),
    certificates: z
      .array(
        z
          .object({
            id,
            stationId: id,
            commonName: z.string().min(1).max(100),
            serial: z.string().regex(/^[a-f0-9]{32}$/),
            certificate: z.string().min(100).max(8192),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

// Only public certificates are imported. Existing station configuration, keys,
// history and revoked identities are never replaced by an offline bundle.
export function importDeviceCertificates(store, input, caPem, actor) {
  const manifest = certificateTransferSchema.parse(input),
    ca = new X509Certificate(caPem),
    now = store.clock();
  if (
    manifest.environment !== store.environment ||
    manifest.caFingerprint !== ca.fingerprint256 ||
    !ca.ca ||
    Date.parse(ca.validFrom) > now ||
    Date.parse(ca.validTo) <= now
  )
    throw new Rejected('Miljø eller produksjons-CA stemmer ikke', 409);
  const seen = new Set();
  const rows = manifest.certificates.map((entry) => {
    const station = store.confirmedValue(`station:${entry.stationId}`),
      cert = new X509Certificate(entry.certificate);
    if (station.model === 'Netatmo') throw new Rejected('Netatmo bruker ikke denne enhetsidentiteten', 400);
    if (seen.has(entry.id) || seen.has(entry.commonName) || seen.has(entry.serial))
      throw new Rejected('Duplisert sertifikatidentitet i pakken', 400);
    seen.add(entry.id);
    seen.add(entry.commonName);
    seen.add(entry.serial);
    if (
      entry.commonName !== `${entry.stationId}.${entry.serial.slice(0, 16)}` ||
      cert.subject !== `CN=${entry.commonName}` ||
      cert.serialNumber.toLowerCase().replace(/^0+/, '') !== entry.serial.replace(/^0+/, '') ||
      cert.ca ||
      !cert.checkIssued(ca) ||
      !cert.verify(ca.publicKey) ||
      Date.parse(cert.validFrom) > now ||
      Date.parse(cert.validTo) <= now ||
      Date.parse(cert.validTo) > Date.parse(ca.validTo) ||
      !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
      cert.keyUsage.includes('1.3.6.1.5.5.7.3.1') ||
      cert.publicKey.asymmetricKeyType !== 'ec' ||
      cert.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    )
      throw new Rejected('Enhetssertifikatets identitet, bruksområde eller signatur er ugyldig', 400);
    return { ...entry, expiresAt: Date.parse(cert.validTo) };
  });
  return store.db
    .transaction(() => {
      let imported = 0,
        existing = 0;
      for (const row of rows) {
        const prior = store.db
          .prepare('SELECT * FROM certificates WHERE id=? OR common_name=? OR serial=?')
          .all(row.id, row.commonName, row.serial);
        if (prior.length) {
          if (
            prior.length !== 1 ||
            prior[0].id !== row.id ||
            prior[0].station_id !== row.stationId ||
            prior[0].common_name !== row.commonName ||
            prior[0].serial !== row.serial ||
            prior[0].certificate !== row.certificate ||
            prior[0].revoked_at !== null
          )
            throw new Rejected('Sertifikatet kolliderer med eller er sperret i eksisterende oppsett', 409);
          existing++;
          continue;
        }
        store.db
          .prepare('INSERT INTO certificates VALUES (?,?,?,?,?,?,NULL)')
          .run(row.id, row.stationId, row.commonName, row.serial, row.expiresAt, row.certificate);
        imported++;
      }
      store.audit(actor, 'device_certificates_imported', {
        imported,
        existing,
        caFingerprint: manifest.caFingerprint,
      });
      return { environment: store.environment, imported, existing };
    })
    .immediate();
}

export function publishImportedCertificateAcl(store) {
  syncAcl(store);
}
