import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { createPublicKey } from 'node:crypto';
import { deviceSchema } from '../server/schema.js';
import { hash } from '../server/store.js';

const path = process.argv[2];
if (!path) throw new Error('Bruk: node scripts/provision-firmware.js <nedlastet enhetspakke.json>');
const bundle = z
  .object({
    stationId: z.string().uuid(),
    environment: z.enum(['production', 'development']),
    certificate: z.string().startsWith('-----BEGIN CERTIFICATE-----'),
    privateKey: z.string().includes('PRIVATE KEY'),
    ca: z.string().startsWith('-----BEGIN CERTIFICATE-----'),
    configuration: deviceSchema,
    firmwarePublicKey: z.string().includes('PUBLIC KEY'),
    certificateId: z.string().uuid(),
  })
  .passthrough()
  .parse(JSON.parse(readFileSync(path, 'utf8')));
if (bundle.stationId !== bundle.configuration.stationId)
  throw new Error('Pakken har motstridende enhetsidentiteter');
if (!process.env.WG_WIFI_SSID || !process.env.WG_WIFI_PASSWORD)
  throw new Error(
    'Sett WG_WIFI_SSID og WG_WIFI_PASSWORD i prosessmiljøet. Verdiene skrives ikke til terminalen.',
  );
if (
  Buffer.byteLength(process.env.WG_WIFI_SSID) > 32 ||
  Buffer.byteLength(process.env.WG_WIFI_PASSWORD) < 8 ||
  Buffer.byteLength(process.env.WG_WIFI_PASSWORD) > 63
)
  throw new Error('Wi-Fi krever SSID på 1–32 byte og WPA2-passord på 8–63 byte');
const destination = resolve('firmware/main');
if (existsSync(join(destination, 'provisioning.h')) && process.env.WG_REPLACE_PROVISIONING !== 'true')
  throw new Error(
    'Det finnes allerede en provisionert enhet. Sett WG_REPLACE_PROVISIONING=true for å velge en annen enhet.',
  );
const literal = (v) => JSON.stringify(v).replace(/\u2028|\u2029/g, ' ');
const otaKey = createPublicKey(bundle.firmwarePublicKey);
if (otaKey.asymmetricKeyType !== 'ec' || otaKey.asymmetricKeyDetails.namedCurve !== 'prime256v1')
  throw new Error('Firmware krever ECDSA P-256-verifikasjonsnøkkel');
const jwk = otaKey.export({ format: 'jwk' }),
  otaHex = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('hex');
const header = `#pragma once\n#define WG_STATION_ID ${literal(bundle.stationId)}\n#define WG_ENVIRONMENT ${literal(bundle.environment)}\n#define WG_WIFI_SSID ${literal(process.env.WG_WIFI_SSID)}\n#define WG_WIFI_PASSWORD ${literal(process.env.WG_WIFI_PASSWORD)}\n#define WG_DEFAULT_CONFIG ${literal(JSON.stringify(bundle.configuration))}\n#define WG_DEFAULT_HASH ${literal(hash(bundle.configuration))}\n#define WG_MINIMUM_EPOCH ${Math.floor(Date.now() / 1000) - 86400}LL\n`;
for (const [file, body] of [
  [
    'provisioning.h',
    header +
      `#define WG_OTA_PUBLIC_KEY_HEX ${literal(otaHex)}\n#define WG_CERTIFICATE_ID ${literal(bundle.certificateId)}\n`,
  ],
  ['device.pem', bundle.certificate],
  ['device.key', bundle.privateKey],
  ['ca.pem', bundle.ca],
])
  writeFileSync(join(destination, file), body, { mode: 0o600 });
console.log(
  `Klargjort firmware for ${bundle.stationId} i ${bundle.environment}. Sertifikater og Wi-Fi-verdier er git-ignorert.`,
);
