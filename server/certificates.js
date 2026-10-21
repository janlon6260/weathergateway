import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  lstatSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { generateKeyPairSync, createPublicKey, X509Certificate, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { hash, Rejected } from './store.js';
import { opensslExecutable } from './pki.js';
import { mqttSubjectAltNames } from './tls-identities.js';
import { validitySchema, validityDays, issuedDays } from './certificate-validity.js';

const execute = promisify(execFile);
export const certificateTypes = {
  ca: { label: 'Rot-CA', stem: 'client-ca', ca: true },
  server: { label: 'MQTT-server', stem: 'server', server: true },
  worker: { label: 'MQTT-arbeider', stem: 'worker', cn: 'gateway-worker' },
  https: { label: 'HTTPS / reverse proxy', stem: 'https', server: true, external: true },
  'database-server': { label: 'Databaseserver', stem: 'database-server', server: true, external: true },
  'database-client': {
    label: 'Databaseklient',
    stem: 'database-client',
    cn: 'weathergateway-database-client',
    external: true,
  },
};
export const certificateRequest = z
  .object({
    type: z.enum(Object.keys(certificateTypes)),
    validity: validitySchema,
    names: z.array(z.string().min(1).max(253)).max(20).default([]),
  })
  .strict();
const publicInfo = (pem) => {
  const c = new X509Certificate(pem);
  return {
    subject: c.subject,
    names: c.subjectAltName || '',
    fingerprint: c.fingerprint256,
    validFrom: Date.parse(c.validFrom),
    expiresAt: Date.parse(c.validTo),
    isCa: c.ca,
  };
};

// Only control mounts this root. Other services receive distinct, minimal role directories.
export class CertificateManager {
  constructor({ store, config, openssl = opensslExecutable }) {
    this.store = store;
    this.config = config;
    this.root = resolve(config.certificateRoot);
    this.openssl = openssl;
    this.busy = false;
    mkdirSync(this.root, { recursive: true, mode: 0o750 });
    this.path('.environment');
    if (!existsSync(this.path('.environment'))) this.atomic('.environment', store.environment, 0o600);
    if (readFileSync(this.path('.environment'), 'utf8').trim() !== store.environment)
      throw new Error('Sertifikatmappen tilhører et annet miljø');
    this.sweep();
    this.publish();
  }
  path(name) {
    if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) || name.split('/').some((p) => p === '..'))
      throw new Error('Ugyldig sertifikatsti');
    let path = this.root;
    if (lstatSync(path).isSymbolicLink()) throw new Error('Sertifikatmappen kan ikke være en symbolsk lenke');
    for (const part of name.split('/')) {
      path = join(path, part);
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Symbolske lenker avvises');
    }
    return path;
  }
  atomic(name, content, mode = 0o640) {
    const path = this.path(name),
      temp = this.path(`${name}.${randomUUID()}.tmp`);
    writeFileSync(temp, content, { flag: 'wx', mode, flush: true });
    try {
      renameSync(temp, path);
      chmodSync(path, mode);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  pending() {
    const row = this.store.db.prepare("SELECT value FROM meta WHERE key='certificate_change'").get();
    return row ? JSON.parse(row.value) : null;
  }
  savePending(change) {
    this.store.db
      .prepare(
        "INSERT INTO meta VALUES ('certificate_change',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(change));
  }
  status() {
    this.sweep();
    const serverPath = this.path('server.pem');
    let defaultNames = [
      new URL(this.store.confirmedValue('gateway').publicOrigin).hostname,
      'broker',
      ...(this.config.mqttServerNames || []),
    ];
    if (existsSync(serverPath)) {
      try {
        defaultNames = new X509Certificate(readFileSync(serverPath)).subjectAltName
          .split(', ')
          .map((v) => v.replace(/^(DNS:|IP Address:)/, ''));
      } catch {
        /* invalid certificates are reported below */
      }
    }
    return {
      environment: this.store.environment,
      maxYears: 50,
      defaultNames: [...new Set(defaultNames)],
      adminName: new URL(this.store.confirmedValue('gateway').adminOrigin).hostname,
      certificates: Object.entries(certificateTypes).map(([type, spec]) => {
        try {
          return {
            type,
            label: spec.label,
            external: !!spec.external,
            ...publicInfo(readFileSync(this.path(spec.stem + '.pem'))),
          };
        } catch (error) {
          return {
            type,
            label: spec.label,
            external: !!spec.external,
            missing: error.code === 'ENOENT',
            invalid: error.code !== 'ENOENT',
          };
        }
      }),
      firmwareSigningReady: existsSync(this.path('firmware-signing-public.pem')),
      firmwarePrivateKeyAvailable: existsSync(this.path('firmware-signing.key')),
      readTokenReady: existsSync(this.path('read-token')),
      pending: this.pending(),
    };
  }
  async exclusive(action) {
    if (this.busy) throw new Rejected('En sertifikathandling pågår. Vent til den er ferdig.', 409);
    this.busy = true;
    try {
      this.sweep();
      return await action();
    } finally {
      this.busy = false;
    }
  }
  async run(args) {
    try {
      await execute(this.openssl, args, { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
    } catch {
      throw new Rejected('Sertifikatet kunne ikke utstedes. Kontroller CA, nøkler og gyldighet.', 422);
    }
  }
  ensureKey(name) {
    if (existsSync(this.path(name))) return;
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.atomic(name, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o400);
  }
  async generate(input, prefix) {
    const request = certificateRequest.parse(input),
      spec = certificateTypes[request.type];
    const keyName = spec.stem + '.key',
      old = this.path(spec.stem + '.pem');
    // Keep existing keys during renewal. There is no implicit CA/key replacement.
    if (existsSync(old) && !existsSync(this.path(keyName)))
      throw new Rejected(
        'Sertifikat finnes uten tilhørende privatnøkkel. Gjenopprett riktig nøkkel fra sikkerhetskopi.',
      );
    this.ensureKey(keyName);
    const key = this.path(keyName),
      pem = this.path(prefix + '.pem');
    const serial = '0x' + randomBytes(16).toString('hex');
    if (spec.ca) {
      const days = String(validityDays(request.validity));
      if (existsSync(old)) {
        const previous = new X509Certificate(readFileSync(old));
        if (!previous.ca || !previous.publicKey.equals(createPublicKey(readFileSync(key))))
          throw new Rejected('Eksisterende CA og privatnøkkel stemmer ikke. Ingen nøkkel erstattes.');
        await this.run([
          'x509',
          '-in',
          old,
          '-signkey',
          key,
          '-set_serial',
          serial,
          '-days',
          days,
          '-sha256',
          '-out',
          pem,
        ]);
      } else {
        await this.run([
          'req',
          '-x509',
          '-new',
          '-key',
          key,
          '-days',
          days,
          '-sha256',
          '-set_serial',
          serial,
          '-subj',
          `/CN=WeatherGateway-${this.store.environment}-ClientCA`,
          '-addext',
          'basicConstraints=critical,CA:TRUE,pathlen:0',
          '-addext',
          'keyUsage=critical,keyCertSign,cRLSign',
          '-out',
          pem,
        ]);
      }
    } else {
      const caPath = this.path('client-ca.pem'),
        caKey = this.path('client-ca.key');
      if (!existsSync(caPath) || !existsSync(caKey)) throw new Rejected('Opprett CA først.');
      const ca = new X509Certificate(readFileSync(caPath));
      if (!ca.publicKey.equals(createPublicKey(readFileSync(caKey))))
        throw new Rejected('CA og privatnøkkel stemmer ikke.');
      const names = request.names.length
        ? request.names
        : request.type === 'server'
          ? [new URL(this.store.confirmedValue('gateway').publicOrigin).hostname.replace(/^\[|\]$/g, '')]
          : request.type === 'https'
            ? [new URL(this.store.confirmedValue('gateway').adminOrigin).hostname]
            : [];
      if (spec.server && !names.length)
        throw new Rejected('Oppgi minst ett DNS-navn eller én IP-adresse.', 400);
      let san = '';
      if (spec.server) {
        try {
          san = mqttSubjectAltNames(names[0], names.slice(1).join(','), request.type === 'server');
        } catch {
          throw new Rejected('Ugyldig DNS-navn eller IP-adresse i sertifikatet.', 400);
        }
      }
      const cn = spec.cn || names[0];
      const ext = prefix + '.cnf',
        csr = prefix + '.csr';
      this.atomic(
        ext,
        `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${spec.server ? 'serverAuth' : 'clientAuth'}\n${san ? 'subjectAltName=' + san + '\n' : ''}`,
        0o600,
      );
      await this.run(['req', '-new', '-key', key, '-subj', `/CN=${cn}`, '-out', this.path(csr)]);
      await this.run([
        'x509',
        '-req',
        '-in',
        this.path(csr),
        '-CA',
        caPath,
        '-CAkey',
        caKey,
        '-set_serial',
        serial,
        '-days',
        String(issuedDays(caPath, request.validity)),
        '-sha256',
        '-extfile',
        this.path(ext),
        '-out',
        pem,
      ]);
    }
    chmodSync(pem, 0o600);
    this.validate(request.type, pem);
    return publicInfo(readFileSync(pem));
  }
  validate(type, path) {
    const spec = certificateTypes[type],
      cert = new X509Certificate(readFileSync(path));
    const key = createPublicKey(readFileSync(this.path(spec.stem + '.key'))),
      now = Date.now();
    if (
      !cert.publicKey.equals(key) ||
      Date.parse(cert.validFrom) > now ||
      Date.parse(cert.validTo) <= now ||
      cert.ca !== !!spec.ca
    )
      throw new Rejected('Sertifikatet bestod ikke kontrollen av nøkkel og gyldighet.');
    if (spec.ca) {
      if (!cert.verify(key)) throw new Rejected('CA-signaturen er ugyldig.');
      for (const child of Object.values(certificateTypes).filter((s) => !s.ca)) {
        const path = this.path(child.stem + '.pem');
        if (
          existsSync(path) &&
          Date.parse(new X509Certificate(readFileSync(path)).validTo) > Date.parse(cert.validTo)
        )
          throw new Rejected(
            'CA kan ikke utløpe før et eksisterende tjenestesertifikat. Velg lengre gyldighet.',
          );
      }
      if (
        this.store.db
          .prepare('SELECT 1 FROM certificates WHERE revoked_at IS NULL AND expires_at>? LIMIT 1')
          .get(Date.parse(cert.validTo))
      )
        throw new Rejected('CA kan ikke utløpe før et eksisterende enhetssertifikat. Velg lengre gyldighet.');
    } else {
      const ca = new X509Certificate(readFileSync(this.path('client-ca.pem')));
      if (
        !cert.verify(ca.publicKey) ||
        Date.parse(cert.validTo) > Date.parse(ca.validTo) ||
        !cert.keyUsage?.includes(spec.server ? '1.3.6.1.5.5.7.3.1' : '1.3.6.1.5.5.7.3.2')
      )
        throw new Rejected('Sertifikatkjede eller bruksområde er ugyldig.');
    }
    return publicInfo(readFileSync(path));
  }
  initialize(input, actor) {
    const options = z
      .object({
        caValidity: validitySchema,
        validity: validitySchema,
        names: z.array(z.string().min(1).max(253)).max(20).default([]),
      })
      .strict()
      .parse(input);
    return this.exclusive(async () => {
      if (this.pending()) throw new Rejected('Fullfør pågående sertifikatendring først.');
      if (
        !existsSync(this.path('client-ca.pem')) &&
        Object.values(certificateTypes).some((spec) => !spec.ca && existsSync(this.path(spec.stem + '.pem')))
      )
        throw new Rejected(
          'CA mangler, men tjenestesertifikater finnes. Gjenopprett riktig CA fra sikkerhetskopi.',
        );
      for (const type of ['ca', 'server', 'worker']) {
        const stem = certificateTypes[type].stem;
        if (existsSync(this.path(stem + '.pem'))) {
          this.validate(type, this.path(stem + '.pem'));
          continue;
        }
        const prefix = '.initial-' + randomUUID();
        try {
          await this.generate(
            {
              type,
              validity: type === 'ca' ? options.caValidity : options.validity,
              names: type === 'server' ? options.names : [],
            },
            prefix,
          );
          renameSync(this.path(prefix + '.pem'), this.path(stem + '.pem'));
          chmodSync(this.path(stem + '.pem'), 0o640);
        } finally {
          this.clean(prefix);
        }
      }
      // A public-only installation may deliberately keep its signer offline.
      if (
        !existsSync(this.path('firmware-signing-public.pem')) ||
        existsSync(this.path('firmware-signing.key'))
      ) {
        this.ensureKey('firmware-signing.key');
        const firmwarePublic = createPublicKey(readFileSync(this.path('firmware-signing.key'))).export({
          type: 'spki',
          format: 'pem',
        });
        if (
          existsSync(this.path('firmware-signing-public.pem')) &&
          readFileSync(this.path('firmware-signing-public.pem'), 'utf8') !== firmwarePublic
        )
          throw new Rejected('Eksisterende firmware-nøkler stemmer ikke.');
        if (!existsSync(this.path('firmware-signing-public.pem')))
          this.atomic('firmware-signing-public.pem', firmwarePublic);
      }
      if (!existsSync(this.path('read-token')))
        this.atomic('read-token', randomBytes(32).toString('base64url'));
      this.publish();
      this.store.audit(actor, 'certificates_initialized', { environment: this.store.environment });
      return this.status();
    });
  }
  stage(input, actor) {
    const request = certificateRequest.parse(input);
    return this.exclusive(async () => {
      if (this.pending()) throw new Rejected('Fullfør eller forkast pågående sertifikatendring først.');
      const prefix = '.change-' + randomUUID();
      try {
        const certificate = await this.generate(request, prefix);
        const change = {
          id: prefix.slice(8),
          prefix,
          type: request.type,
          state: 'draft',
          actor,
          createdAt: this.store.clock(),
          certificate,
          candidateHash: hash(readFileSync(this.path(prefix + '.pem'), 'utf8')),
        };
        this.savePending(change);
        this.store.audit(actor, 'certificate_staged', {
          type: request.type,
          fingerprint: certificate.fingerprint,
        });
        return change;
      } catch (error) {
        this.clean(prefix);
        throw error;
      }
    });
  }
  test(changeId, actor) {
    this.sweep();
    const change = this.getChange(changeId),
      stem = certificateTypes[change.type].stem;
    if (change.state !== 'draft') throw new Rejected('Sertifikatet er allerede under testing.');
    this.validate(change.type, this.path(change.prefix + '.pem'));
    if (hash(readFileSync(this.path(change.prefix + '.pem'), 'utf8')) !== change.candidateHash)
      throw new Rejected('Utkastet er endret. Generer på nytt.');
    const existing = this.path(stem + '.pem');
    change.previousExists = existsSync(existing);
    if (change.previousExists) this.atomic(change.prefix + '.previous.pem', readFileSync(existing), 0o600);
    change.state = 'testing';
    change.deadline = this.store.clock() + this.store.confirmedValue('gateway').confirmationSeconds * 1000;
    // Persist rollback before publishing anything; startup resumes this deadline.
    this.savePending(change);
    try {
      this.atomic(stem + '.pem', readFileSync(this.path(change.prefix + '.pem')));
      this.publish();
      this.store.audit(actor, 'certificate_test_started', { type: change.type, deadline: change.deadline });
      return { ...change, checks: { key: true, chain: true, validity: true, usage: true } };
    } catch (error) {
      this.rollback(change.id, actor);
      throw error;
    }
  }
  confirm(changeId, actor) {
    this.sweep();
    const change = this.getChange(changeId),
      stem = certificateTypes[change.type].stem;
    if (change.state !== 'testing') throw new Rejected('Test sertifikatet først.');
    this.validate(change.type, this.path(stem + '.pem'));
    if (hash(readFileSync(this.path(stem + '.pem'), 'utf8')) !== change.candidateHash)
      throw new Rejected('Det aktive sertifikatet er endret.');
    this.finish(change, actor, 'certificate_confirmed');
    return { ok: true };
  }
  getChange(changeId) {
    const change = this.pending();
    if (!change || change.id !== changeId)
      throw new Rejected('Sertifikatendringen finnes ikke eller er utløpt.', 409);
    return change;
  }
  rollback(changeId, actor = 'certificate-watchdog') {
    const change = this.getChange(changeId),
      stem = certificateTypes[change.type].stem;
    if (change.state === 'testing') {
      if (change.previousExists)
        this.atomic(stem + '.pem', readFileSync(this.path(change.prefix + '.previous.pem')));
      else if (existsSync(this.path(stem + '.pem'))) unlinkSync(this.path(stem + '.pem'));
      this.publish();
    }
    this.finish(change, actor, 'certificate_rolled_back');
    return { ok: true };
  }
  finish(change, actor, action) {
    this.store.db.prepare("DELETE FROM meta WHERE key='certificate_change'").run();
    this.clean(change.prefix);
    this.store.audit(actor, action, { type: change.type, fingerprint: change.certificate.fingerprint });
  }
  clean(prefix) {
    for (const suffix of ['.pem', '.previous.pem', '.csr', '.cnf']) {
      const path = this.path(prefix + suffix);
      if (existsSync(path)) unlinkSync(path);
    }
  }
  sweep() {
    const change = this.pending();
    if (change?.state === 'testing' && change.deadline <= this.store.clock()) this.rollback(change.id);
  }
  publish() {
    const roles = {
      broker: ['client-ca.pem', 'server.pem', 'server.key'],
      worker: [
        'client-ca.pem',
        'worker.pem',
        'worker.key',
        'db-ca.pem',
        'database-client.pem',
        'database-client.key',
        'weather-db-encryption.key',
      ],
      public: ['read-token'],
    };
    mkdirSync(this.path('roles'), { recursive: true, mode: 0o750 });
    for (const [role, files] of Object.entries(roles)) {
      const directory = `roles/${role}`;
      mkdirSync(this.path(directory), { recursive: true, mode: 0o750 });
      const contents = [];
      for (const file of files) {
        const source = this.path(file),
          destination = `${directory}/${file}`;
        if (existsSync(source)) {
          const content = readFileSync(source);
          if (!existsSync(this.path(destination)) || !readFileSync(this.path(destination)).equals(content))
            this.atomic(destination, content, file.endsWith('.key') ? 0o440 : 0o640);
          contents.push([file, hash(content.toString('utf8'))]);
        } else if (existsSync(this.path(destination))) unlinkSync(this.path(destination));
      }
      const generation = hash(contents);
      if (
        !existsSync(this.path(`${directory}/generation`)) ||
        readFileSync(this.path(`${directory}/generation`), 'utf8') !== generation
      )
        this.atomic(`${directory}/generation`, generation);
    }
  }
  export(type, actor) {
    const spec = certificateTypes[type];
    let result;
    if (spec)
      result = {
        type,
        certificate: readFileSync(this.path(spec.stem + '.pem'), 'utf8'),
        privateKey: readFileSync(this.path(spec.stem + '.key'), 'utf8'),
        ca: readFileSync(this.path('client-ca.pem'), 'utf8'),
      };
    else if (type === 'firmware')
      result = {
        type,
        privateKey: readFileSync(this.path('firmware-signing.key'), 'utf8'),
        publicKey: readFileSync(this.path('firmware-signing-public.pem'), 'utf8'),
      };
    else if (type === 'read-token') result = { type, token: readFileSync(this.path('read-token'), 'utf8') };
    else throw new Rejected('Ukjent sertifikattype', 400);
    this.store.audit(actor, 'certificate_exported', { type });
    return { environment: this.store.environment, ...result };
  }
}
