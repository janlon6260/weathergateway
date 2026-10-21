import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
  X509Certificate,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { deviceSchema, id } from './schema.js';
import { hash, Rejected } from './store.js';
import { validitySchema } from './certificate-validity.js';
import { manifestBytes, uploadFirmware } from './firmware-updates.js';
import { usbLayout, usbManifestText, validateUsbManifest } from '../shared/usb-firmware.js';
import { latest } from './observations.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const wifiText = z.string().refine((s) => !/[\x00-\x1f\x7f]/.test(s), 'Ugyldige Wi-Fi-tegn');
export const firmwareBuildInput = z
  .object({
    mqttHost: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/)
      .refine((s) => !s.includes('..')),
    mqttPort: z.number().int().min(1).max(65535),
    ssid: wifiText.refine(
      (s) => Buffer.byteLength(s) >= 1 && Buffer.byteLength(s) <= 32,
      'SSID må være 1–32 byte',
    ),
    wifiPassword: wifiText.optional(),
    purpose: z.enum(['usb', 'ota']),
    validity: validitySchema.optional(),
    configuration: deviceSchema.optional(),
  })
  .strict();

function atomic(path, value) {
  writeFileSync(`${path}.tmp`, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function boundedJson(path, maximum = 3000000) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    throw new Rejected('Ugyldig byggresultat');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export class FirmwareBuilds {
  constructor({ store, config, certificates, certificateManager }) {
    Object.assign(this, { store, config, certificates, certificateManager });
    this.root = store.safe('system', 'firmware-builds');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.preparing = false;
  }
  key(create = true) {
    const path = join(this.config.certificateRoot, 'device-vault.key');
    if (!existsSync(path)) {
      if (!create)
        throw new Rejected(
          'Enhetslagerets nøkkel mangler. Gjenopprett device-vault.key fra sikkerhetskopi.',
          503,
        );
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    const key = readFileSync(path);
    if (key.length !== 32) throw new Rejected('Ugyldig nøkkel for enhetslager', 503);
    return key;
  }
  vaultPath(stationId) {
    return join(this.store.stationDirectory(stationId, 'firmware'), 'identity.enc');
  }
  saveIdentity(stationId, identity) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(`${this.store.environment}:${stationId}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(identity)), cipher.final()]);
    this.store.db
      .prepare(
        'INSERT INTO settings_secrets VALUES (?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload',
      )
      .run(`firmware:${stationId}`, Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64'));
  }
  identity(stationId) {
    const path = this.vaultPath(stationId);
    let row = this.store.db
      .prepare('SELECT payload FROM settings_secrets WHERE name=?')
      .get(`firmware:${stationId}`);
    if (!row && existsSync(path)) {
      this.store.db
        .prepare('INSERT INTO settings_secrets VALUES (?,?)')
        .run(`firmware:${stationId}`, readFileSync(path, 'utf8'));
      row = this.store.db
        .prepare('SELECT payload FROM settings_secrets WHERE name=?')
        .get(`firmware:${stationId}`);
    }
    if (!row) return null;
    const data = Buffer.from(row.payload, 'base64'),
      cipher = createDecipheriv('aes-256-gcm', this.key(false), data.subarray(0, 12));
    cipher.setAAD(Buffer.from(`${this.store.environment}:${stationId}`));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
  }
  remember(bundle) {
    const previous = this.identity(bundle.stationId);
    const previousIdentities =
      previous?.privateKey && previous.privateKey !== bundle.privateKey
        ? [
            {
              privateKey: previous.privateKey,
              certificateId: previous.certificateId,
              certificate: previous.certificate,
            },
            ...(previous.previousIdentities || []),
          ].slice(0, 5)
        : previous?.previousIdentities || [];
    this.saveIdentity(bundle.stationId, { ...previous, ...bundle, previousIdentities });
  }
  importIdentity(stationId, input, actor) {
    this.station(stationId);
    const bundle = z
      .object({
        stationId: id,
        environment: z.string(),
        certificateId: id,
        privateKey: z.string().max(8192),
        certificate: z.string().max(8192),
      })
      .passthrough()
      .parse(input);
    if (bundle.stationId !== stationId || bundle.environment !== this.store.environment)
      throw new Rejected('Enhetspakken gjelder en annen stasjon eller et annet miljø', 400);
    const certificate = this.store.db
      .prepare(
        'SELECT * FROM certificates WHERE id=? AND station_id=? AND revoked_at IS NULL AND expires_at>?',
      )
      .get(bundle.certificateId, stationId, this.store.clock());
    if (!certificate || certificate.certificate !== bundle.certificate)
      throw new Rejected('Sertifikatet er ukjent, utløpt eller tilbakekalt');
    let privateKey;
    try {
      privateKey = createPrivateKey(bundle.privateKey);
    } catch {
      throw new Rejected('Enhetspakken inneholder ikke en gyldig privatnøkkel', 400);
    }
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails.namedCurve !== 'prime256v1')
      throw new Rejected('Enhetsidentiteten må bruke ECDSA P-256', 400);
    const key = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (
      !key.equals(new X509Certificate(bundle.certificate).publicKey.export({ type: 'spki', format: 'der' }))
    )
      throw new Rejected('Privatnøkkelen passer ikke til sertifikatet', 400);
    this.remember({
      stationId,
      certificateId: bundle.certificateId,
      certificate: bundle.certificate,
      privateKey: bundle.privateKey,
    });
    this.store.audit(actor, 'firmware_identity_imported', { stationId, certificateId: bundle.certificateId });
    return { ok: true };
  }
  station(stationId) {
    id.parse(stationId);
    const station = this.store.confirmedValue(`station:${stationId}`);
    if (!station.enabled || station.model === 'Netatmo') throw new Rejected('Velg en aktiv ESP32-stasjon');
    return station;
  }
  workerReady() {
    try {
      const status = boundedJson(join(this.root, 'worker.json'), 4096);
      return (
        status.environment === this.store.environment &&
        Date.now() - status.at < 20000 &&
        status.at <= Date.now() + 5000
      );
    } catch {
      return false;
    }
  }
  status(stationId) {
    this.station(stationId);
    this.poll();
    const identity = this.identity(stationId);
    return {
      available: this.workerReady(),
      configuration: this.store.confirmedValue(`device:${stationId}`),
      ssid: identity?.ssid || '',
      hasWifiPassword: !!identity?.wifiPassword,
      hasIdentity: !!identity?.privateKey,
      builds: this.store.db
        .prepare('SELECT * FROM firmware_builds WHERE station_id=? ORDER BY created_at DESC LIMIT 20')
        .all(stationId)
        .map((row) => this.public(row)),
    };
  }
  public(row) {
    const p = JSON.parse(row.payload);
    return {
      id: row.id,
      stationId: row.station_id,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      purpose: p.purpose,
      mqttHost: p.configuration.mqttHost,
      mqttPort: p.configuration.mqttPort,
      ssid: p.ssid,
      version: p.version,
      releaseId: row.release_id,
      error: row.error,
      log: row.log,
    };
  }
  row(buildId) {
    const row = this.store.db.prepare('SELECT * FROM firmware_builds WHERE id=?').get(id.parse(buildId));
    if (!row) throw new Rejected('Bygget finnes ikke', 404);
    return row;
  }
  assertCurrent(payload) {
    if (hash(this.store.confirmedValue(`device:${payload.configuration.stationId}`)) !== payload.baseHash)
      throw new Rejected('Enhetsinnstillingene er endret siden bygget. Opprett et nytt bygg.');
  }
  async start(stationId, input, actor) {
    this.station(stationId);
    if (
      this.preparing ||
      this.store.db.prepare("SELECT 1 FROM firmware_builds WHERE state IN ('queued','building')").get()
    )
      throw new Rejected('Et firmwarebygg pågår allerede', 409);
    if (!this.workerReady())
      throw new Rejected('Firmwarebyggeren kjører ikke. Start firmware-builder i Docker-stakken.', 503);
    if (this.certificateManager?.pending()) throw new Rejected('Fullfør sertifikatendringen før bygging');
    if (
      !this.certificates ||
      ![
        this.config.issuerCaFile,
        join(this.config.certificateRoot, 'server.pem'),
        join(this.config.certificateRoot, 'firmware-signing.key'),
        this.config.firmwarePublicKeyFile,
      ].every((file) => file && existsSync(file))
    )
      throw new Rejected('Opprett CA, MQTT-sertifikater og firmware-nøkler under Sertifikater først.', 409);
    if (
      this.store
        .changes()
        .some(
          (c) =>
            ['draft', 'testing', 'confirming'].includes(c.state) &&
            [`device:${stationId}`, `firmware:${stationId}`].includes(c.scope),
        )
    )
      throw new Rejected('Avslutt enhets- og firmwaretester før et nytt bygg.');
    const values = firmwareBuildInput.parse(input);
    const current = this.store.confirmedValue(`device:${stationId}`),
      configuration = deviceSchema.parse({
        ...(values.configuration || current),
        mqttHost: values.mqttHost,
        mqttPort: values.mqttPort,
      });
    if (configuration.stationId !== stationId)
      throw new Rejected('Maskinvareoppsettet tilhører en annen stasjon', 400);
    if (configuration.interface === 'davis-iss-rs485-capture') {
      if (this.station(stationId).model !== 'Davis Vantage Pro2')
        throw new Rejected('Direkte kablet ISS krever Vantage Pro2', 400);
      if (values.purpose !== 'usb')
        throw new Rejected('Uverifisert RS-485-opptaksprofil kan bare installeres via USB', 409);
    }
    const serverCert = new X509Certificate(readFileSync(join(this.config.certificateRoot, 'server.pem')));
    if (
      !(isIP(values.mqttHost) ? serverCert.checkIP(values.mqttHost) : serverCert.checkHost(values.mqttHost))
    )
      throw new Rejected(
        'Gatewayadressen mangler i MQTT-serversertifikatet. Legg til IP/DNS-navnet under Sertifikater først.',
      );
    const signingKey = createPrivateKey(
      readFileSync(join(this.config.certificateRoot, 'firmware-signing.key')),
    );
    const publicKey = createPublicKey(signingKey),
      jwk = publicKey.export({ format: 'jwk' });
    if (
      jwk.crv !== 'P-256' ||
      !publicKey.export({ type: 'spki', format: 'der' }).equals(
        createPublicKey(readFileSync(this.config.firmwarePublicKeyFile)).export({
          type: 'spki',
          format: 'der',
        }),
      )
    )
      throw new Rejected('Firmware-nøklene stemmer ikke overens');
    this.preparing = true;
    try {
      let identity = this.identity(stationId);
      if (values.purpose === 'ota' && identity) {
        const activeId = latest(this.store, stationId)?.certificateId;
        const activeCertificate =
          activeId &&
          this.store.db
            .prepare('SELECT certificate FROM certificates WHERE id=? AND station_id=?')
            .get(activeId, stationId);
        if (activeCertificate) {
          const activePublic = new X509Certificate(activeCertificate.certificate).publicKey.export({
            type: 'spki',
            format: 'der',
          });
          const match = [identity, ...(identity.previousIdentities || [])].find((candidate) =>
            createPublicKey(candidate.privateKey)
              .export({ type: 'spki', format: 'der' })
              .equals(activePublic),
          );
          if (!match)
            throw new Rejected(
              'Den tilkoblede ESP32 bruker en annen privatnøkkel. Importer den opprinnelige enhetspakken før OTA.',
            );
          const alternatives = [identity, ...(identity.previousIdentities || [])]
            .filter((c) => c.privateKey !== match.privateKey)
            .map(({ privateKey, certificateId, certificate }) => ({ privateKey, certificateId, certificate }))
            .slice(0, 5);
          identity = { ...identity, ...match, previousIdentities: alternatives };
        }
      }
      const wifiPassword = values.wifiPassword || identity?.wifiPassword;
      if (!wifiPassword || Buffer.byteLength(wifiPassword) < 8 || Buffer.byteLength(wifiPassword) > 63)
        throw new Rejected('Wi-Fi-passordet må være 8–63 byte', 400);
      if (!identity?.privateKey) {
        if (values.purpose === 'ota')
          throw new Rejected(
            'Importer den opprinnelige enhetspakken, eller installer først via USB. OTA må beholde enhetens privatnøkkel.',
          );
        identity = await this.certificates.issue(stationId, values.validity || { amount: 1, unit: 'years' });
      }
      // Renewal preserves the public key. Prefer the newest valid certificate for this key.
      const deviceKey = createPublicKey(identity.privateKey).export({ type: 'spki', format: 'der' });
      const cert = this.store.db
        .prepare(
          'SELECT * FROM certificates WHERE station_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY expires_at DESC',
        )
        .all(stationId, this.store.clock())
        .find((c) =>
          new X509Certificate(c.certificate).publicKey
            .export({ type: 'spki', format: 'der' })
            .equals(deviceKey),
        );
      if (!cert)
        throw new Rejected(
          'Enhetssertifikatet er utløpt eller tilbakekalt. Utsted et nytt og installer via USB.',
        );
      identity = {
        ...identity,
        certificateId: cert.id,
        certificate: cert.certificate,
        ssid: values.ssid,
        wifiPassword,
      };
      this.saveIdentity(stationId, identity);
      const buildId = randomUUID(),
        directory = join(this.root, buildId);
      mkdirSync(directory, { mode: 0o700 });
      const literal = (s) => JSON.stringify(s),
        otaHex = Buffer.concat([
          Buffer.from([4]),
          Buffer.from(jwk.x, 'base64url'),
          Buffer.from(jwk.y, 'base64url'),
        ]).toString('hex');
      const header = `#pragma once\n#define WG_STATION_ID ${literal(stationId)}\n#define WG_ENVIRONMENT ${literal(this.store.environment)}\n#define WG_WIFI_SSID ${literal(values.ssid)}\n#define WG_WIFI_PASSWORD ${literal(wifiPassword)}\n#define WG_DEFAULT_CONFIG ${literal(JSON.stringify(configuration))}\n#define WG_DEFAULT_HASH ${literal(hash(configuration))}\n#define WG_MINIMUM_EPOCH ${Math.floor(Date.now() / 1000) - 86400}LL\n#define WG_OTA_PUBLIC_KEY_HEX ${literal(otaHex)}\n#define WG_CERTIFICATE_ID ${literal(cert.id)}\n#define WG_BUILD_ID ${literal(buildId)}\n`;
      const payload = {
        purpose: values.purpose,
        configuration,
        baseHash: hash(current),
        certificateId: cert.id,
        ssid: values.ssid,
        otaHex,
        buildId,
      };
      this.store.db
        .prepare(
          'INSERT INTO firmware_builds(id,station_id,state,created_at,updated_at,payload) VALUES (?,?,?,?,?,?)',
        )
        .run(buildId, stationId, 'queued', this.store.clock(), this.store.clock(), JSON.stringify(payload));
      atomic(join(directory, 'request.json'), {
        format: 1,
        environment: this.store.environment,
        buildId,
        files: {
          'provisioning.h': header,
          'device.pem': cert.certificate,
          'device.key': identity.privateKey,
          'ca.pem': readFileSync(this.config.issuerCaFile, 'utf8'),
        },
      });
      this.store.audit(actor, 'firmware_build_requested', { buildId, stationId, purpose: values.purpose });
      return this.public(this.row(buildId));
    } finally {
      this.preparing = false;
    }
  }
  poll() {
    for (const row of this.store.db
      .prepare("SELECT * FROM firmware_builds WHERE state IN ('queued','building')")
      .all()) {
      const directory = join(this.root, row.id),
        resultPath = join(directory, 'result.json');
      try {
        if (existsSync(join(directory, 'progress.json'))) {
          const progress = boundedJson(join(directory, 'progress.json'), 24000);
          this.store.db
            .prepare("UPDATE firmware_builds SET state='building',log=?,updated_at=? WHERE id=?")
            .run(String(progress.log || '').slice(-16000), this.store.clock(), row.id);
        }
        if (!existsSync(resultPath)) {
          if (this.store.clock() - row.created_at > 30 * 60 * 1000)
            this.fail(row, 'Bygget overskred 30 minutter. Start byggeren på nytt.', directory);
          continue;
        }
        const result = boundedJson(resultPath, 3000000);
        if (result.error) {
          this.fail(row, 'Kompileringen mislyktes. Se byggloggen.', directory);
          continue;
        }
        const p = JSON.parse(row.payload);
        if (result.buildId !== row.id || result.environment !== this.store.environment)
          throw new Error('Byggidentiteten stemmer ikke');
        const images = result.images.map((v) => Buffer.from(v, 'base64'));
        if (images.length !== 4) throw new Error('Feil antall firmwaresegmenter');
        const app = images[3];
        if (app.length < 1024 || app[0] !== 0xe9 || app.readUInt32LE(32) !== 0xabcd5432)
          throw new Error('Ugyldig ESP32-image');
        const version = app.subarray(48, 80).toString('utf8').split('\0')[0];
        for (const value of [
          row.station_id,
          this.store.environment,
          p.certificateId,
          hash(p.configuration),
          p.otaHex,
          row.id,
        ])
          if (!app.includes(Buffer.from(value))) throw new Error('Firmwaren passer ikke til bestillingen');
        const manifest = validateUsbManifest({
          format: 'wg-usb-flash-1',
          stationId: row.station_id,
          environment: this.store.environment,
          certificateId: p.certificateId,
          configurationHash: hash(p.configuration),
          version,
          chip: 'esp32',
          flashSize: 4194304,
          securityProfile: 'standard',
          segments: usbLayout.map((s, i) => ({
            name: s.name,
            address: s.address,
            size: images[i].length,
            sha256: sha(images[i]),
          })),
        });
        const key = createPrivateKey(readFileSync(join(this.config.certificateRoot, 'firmware-signing.key')));
        const signature = sign('sha256', Buffer.from(usbManifestText(manifest)), {
          key,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64');
        const sequence =
          Math.max(
            0,
            ...this.store.db
              .prepare('SELECT manifest FROM firmware_releases WHERE station_id=?')
              .all(row.station_id)
              .map((r) => JSON.parse(r.manifest).sequence),
          ) + 1;
        const ota = {
          format: 'wg-firmware-1',
          stationId: row.station_id,
          environment: this.store.environment,
          version,
          sequence,
          size: app.length,
          sha256: sha(app),
        };
        const release = uploadFirmware(
          this.store,
          this.config,
          {
            manifest: ota,
            image: app.toString('base64'),
            signature: sign('sha256', manifestBytes(ota), { key, dsaEncoding: 'ieee-p1363' }).toString(
              'base64',
            ),
          },
          'firmware-builder',
        );
        atomic(join(this.store.stationDirectory(row.station_id, 'firmware'), `${row.id}.usb-flash.json`), {
          manifest,
          signature,
          images: result.images,
        });
        this.store.db
          .prepare("UPDATE firmware_builds SET state='ready',updated_at=?,payload=?,release_id=? WHERE id=?")
          .run(this.store.clock(), JSON.stringify({ ...p, version }), release.releaseId, row.id);
        this.store.audit('firmware-builder', 'firmware_build_ready', {
          buildId: row.id,
          stationId: row.station_id,
          releaseId: release.releaseId,
        });
        this.cleanup(directory);
      } catch {
        this.fail(row, 'Byggresultatet kunne ikke godkjennes. Opprett et nytt bygg.', directory);
      }
    }
  }
  cleanup(directory) {
    // Directory is always this.root + a database UUID; never supplied as a path by the caller.
    for (const name of ['request.json', 'result.json', 'progress.json']) {
      const path = join(directory, name);
      if (existsSync(path)) unlinkSync(path);
    }
  }
  fail(row, error, directory) {
    this.store.db
      .prepare("UPDATE firmware_builds SET state='failed',updated_at=?,error=? WHERE id=?")
      .run(this.store.clock(), error, row.id);
    atomic(join(directory, 'cancel'), 'cancelled');
    this.cleanup(directory);
  }
  usb(buildId) {
    this.poll();
    const row = this.row(buildId);
    if (row.state !== 'ready') throw new Rejected('Bygget er ikke ferdig');
    const p = JSON.parse(row.payload);
    if (hash(this.store.confirmedValue(`device:${row.station_id}`)) !== hash(p.configuration))
      this.assertCurrent(p);
    return boundedJson(
      join(this.store.stationDirectory(row.station_id, 'firmware'), `${row.id}.usb-flash.json`),
    );
  }
  usbComplete(buildId, actor, { bootConfirmed = false } = {}) {
    const row = this.row(buildId);
    this.usb(buildId);
    const p = JSON.parse(row.payload);
    if (
      this.store
        .changes()
        .some(
          (c) =>
            ['draft', 'testing', 'confirming'].includes(c.state) &&
            [`device:${row.station_id}`, `firmware:${row.station_id}`].includes(c.scope),
        )
    )
      throw new Rejected('Avslutt enhets- og firmwaretester først');
    this.store.db
      .transaction(() => {
        this.store.db
          .prepare('UPDATE configuration SET payload=?,revision=revision+1 WHERE scope=?')
          .run(JSON.stringify(p.configuration), `device:${row.station_id}`);
        this.store.initialize(`firmware:${row.station_id}`, { stationId: row.station_id, releaseId: null });
        this.store.db
          .prepare('UPDATE configuration SET payload=?,revision=revision+1 WHERE scope=?')
          .run(
            JSON.stringify({ stationId: row.station_id, releaseId: row.release_id }),
            `firmware:${row.station_id}`,
          );
        this.store.audit(actor, 'usb_firmware_installed', {
          buildId,
          bootConfirmed,
          stationId: row.station_id,
          releaseId: row.release_id,
        });
      })
      .immediate();
    return { ok: true };
  }
  cancel(buildId, actor) {
    const row = this.row(buildId);
    if (!['queued', 'building'].includes(row.state)) throw new Rejected('Bygget er allerede avsluttet');
    this.fail(row, 'Avbrutt av administrator', join(this.root, row.id));
    this.store.audit(actor, 'firmware_build_cancelled', { buildId, stationId: row.station_id });
    return { ok: true };
  }
}
