import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export class SettingsSecrets {
  constructor(store, root, { keyName = 'settings-encryption.key' } = {}) {
    this.store = store;
    this.root = root;
    this.keyName = keyName;
  }
  key(create) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, this.keyName);
    if (!existsSync(path)) {
      if (!create) throw new Error('Nøkkel for krypterte innstillinger mangler');
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600, flush: true });
    }
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('Ugyldig innstillingsnøkkel');
    return key;
  }
  set(name, value) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(true), nonce);
    cipher.setAAD(Buffer.from(`${this.store.environment}:${name}`));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
    this.store.db
      .prepare(
        'INSERT INTO settings_secrets VALUES (?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload',
      )
      .run(name, encrypted);
    return name;
  }
  get(name) {
    if (!name) return '';
    const row = this.store.db.prepare('SELECT payload FROM settings_secrets WHERE name=?').get(name);
    if (!row) throw new Error('Kryptert innstilling finnes ikke');
    const bytes = Buffer.from(row.payload, 'base64'),
      decipher = createDecipheriv('aes-256-gcm', this.key(false), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${this.store.environment}:${name}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
}
