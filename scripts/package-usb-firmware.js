import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { usbLayout, usbManifestText, validateUsbManifest } from '../shared/usb-firmware.js';

const [buildPath, signingPath, outputPath] = process.argv.slice(2);
if (!outputPath)
  throw new Error(
    'Bruk: node scripts/package-usb-firmware.js firmware/build-short privat-signering.pem runtime/stasjon.usb-flash.json',
  );
const root = realpathSync(buildPath);
function buildFile(path) {
  const target = realpathSync(resolve(root, path)),
    rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Byggfilen ligger utenfor byggmappen');
  return readFileSync(target);
}
const args = JSON.parse(buildFile('flasher_args.json'));
const description = JSON.parse(buildFile('project_description.json'));
const sdk = JSON.parse(buildFile('config/sdkconfig.json'));
if (
  sdk.SECURE_BOOT ||
  sdk.SECURE_BOOT_V2_ENABLED ||
  sdk.SECURE_FLASH_ENC_ENABLED ||
  sdk.NVS_ENCRYPTION ||
  args.extra_esptool_args?.chip !== 'esp32' ||
  args.flash_settings?.flash_size !== '4MB'
)
  throw new Error(
    'USB-flasheren støtter standard ESP32/4 MB. Maskinvaresikret førstegangsoppsett må gjøres med ESP-IDF.',
  );
const header = readFileSync(join(description.project_path, 'main', 'provisioning.h'), 'utf8');
const define = (name) => {
  const match = header.match(new RegExp(`^#define ${name} (.+)$`, 'm'));
  if (!match) throw new Error(`Mangler ${name}`);
  return JSON.parse(match[1]);
};
const app = buildFile(args.app.file);
if (
  app.length < 80 ||
  app[0] !== 0xe9 ||
  app.readUInt32LE(32) !== 0xabcd5432 ||
  app.subarray(48, 80).toString('utf8').split('\0')[0] !== description.project_version
)
  throw new Error('Appens versjon stemmer ikke med bygget. Bygg firmware på nytt.');
// Reject stale builds belonging to another station or credential, without printing embedded secrets.
for (const name of [
  'WG_STATION_ID',
  'WG_ENVIRONMENT',
  'WG_CERTIFICATE_ID',
  'WG_DEFAULT_HASH',
  'WG_OTA_PUBLIC_KEY_HEX',
])
  if (!app.includes(Buffer.from(define(name))))
    throw new Error('Bygget stemmer ikke med provisjoneringen. Bygg firmware på nytt.');
const images = usbLayout.map((part) => {
  const file = args.flash_files[`0x${part.address.toString(16)}`];
  if (!file) throw new Error('Uventet partisjonsoppsett');
  return buildFile(file);
});
const manifest = validateUsbManifest({
  format: 'wg-usb-flash-1',
  stationId: define('WG_STATION_ID'),
  environment: define('WG_ENVIRONMENT'),
  certificateId: define('WG_CERTIFICATE_ID'),
  configurationHash: define('WG_DEFAULT_HASH'),
  version: description.project_version,
  chip: 'esp32',
  flashSize: 4194304,
  securityProfile: 'standard',
  segments: usbLayout.map((s, i) => ({
    name: s.name,
    address: s.address,
    size: images[i].length,
    sha256: createHash('sha256').update(images[i]).digest('hex'),
  })),
});
const key = createPrivateKey(readFileSync(signingPath));
if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1')
  throw new Error('Krever ECDSA P-256-nøkkel');
const publicKey = createPublicKey(key).export({ format: 'jwk' });
const publicHex = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(publicKey.x, 'base64url'),
  Buffer.from(publicKey.y, 'base64url'),
]).toString('hex');
if (publicHex !== define('WG_OTA_PUBLIC_KEY_HEX'))
  throw new Error('Signeringsnøkkelen stemmer ikke med firmwareprovisjoneringen');
const signature = sign('sha256', Buffer.from(usbManifestText(manifest)), {
  key,
  dsaEncoding: 'ieee-p1363',
}).toString('base64');
writeFileSync(
  outputPath,
  JSON.stringify({ manifest, signature, images: images.map((i) => i.toString('base64')) }),
  { flag: 'wx', mode: 0o600 },
);
console.log(JSON.stringify({ stationId: manifest.stationId, version: manifest.version, outputPath }));
