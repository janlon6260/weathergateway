import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { firmwareManifestSchema } from '../server/schema.js';
import { manifestBytes } from '../server/firmware-updates.js';

const [imagePath, stationId, environment, version, sequence, signingKeyPath, outputPath] =
  process.argv.slice(2);
if (!outputPath)
  throw new Error(
    'Bruk: node scripts/sign-firmware.js app.bin STASJONS_UUID production|development VERSJON SEKVENS privat-signering.pem utgivelse.json',
  );
const image = readFileSync(imagePath),
  key = createPrivateKey(readFileSync(signingKeyPath));
if (
  image[0] !== 0xe9 ||
  key.asymmetricKeyType !== 'ec' ||
  key.asymmetricKeyDetails.namedCurve !== 'prime256v1'
)
  throw new Error('Krever ESP32-appbilde og ECDSA P-256-signering');
const manifest = firmwareManifestSchema.parse({
  format: 'wg-firmware-1',
  stationId,
  environment,
  version,
  sequence: Number(sequence),
  size: image.length,
  sha256: createHash('sha256').update(image).digest('hex'),
});
const signature = sign('sha256', manifestBytes(manifest), { key, dsaEncoding: 'ieee-p1363' }).toString(
  'base64',
);
writeFileSync(outputPath, JSON.stringify({ manifest, signature, image: image.toString('base64') }), {
  flag: 'wx',
  mode: 0o600,
});
console.log(
  JSON.stringify({
    stationId,
    environment,
    version,
    sequence: manifest.sequence,
    sha256: manifest.sha256,
    outputPath,
  }),
);
