import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { gatewaySchema, defaultDevice, databaseSchema } from './schema.js';

const commaSeparated = (value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export function secret(name, env = process.env, { optional = false } = {}) {
  try {
    return env[`${name}_FILE`]
      ? readFileSync(env[`${name}_FILE`], 'utf8').replace(/\r?\n$/, '')
      : env[name] || '';
  } catch (error) {
    if (optional && error.code === 'ENOENT') return '';
    throw error;
  }
}
export function configuration(env = process.env) {
  const environment = env.WG_ENVIRONMENT || 'development',
    role = env.WG_ROLE || 'control';
  if (
    !['production', 'development', 'test'].includes(environment) ||
    !['control', 'worker', 'public'].includes(role)
  )
    throw new Error('Ugyldig miljø eller tjenesterolle');
  const secureCookies = env.WG_ALLOW_LOCAL_HTTP !== 'true';
  if (!secureCookies && environment === 'production') throw new Error('Produksjon krever HTTPS-sesjoner');
  const bind = env.WG_BIND || '127.0.0.1';
  if (!secureCookies && bind !== '127.0.0.1') throw new Error('HTTP-utvikling kan bare bindes til loopback');
  const defaults = gatewaySchema.parse({
    confirmationSeconds: 300,
    adminOrigin: env.WG_ADMIN_ORIGIN || 'https://weathergateway.skrg.no',
    publicOrigin: env.WG_PUBLIC_ORIGIN || 'https://wg-api.skrg.no',
    ...(env.WG_DEVELOPMENT_ORIGIN ? { developmentOrigin: env.WG_DEVELOPMENT_ORIGIN } : {}),
    ...(env.WG_PRODUCTION_ORIGIN ? { productionOrigin: env.WG_PRODUCTION_ORIGIN } : {}),
    directory: {
      urls: commaSeparated(env.WG_LDAP_URLS || ''),
      baseDn: env.WG_LDAP_BASE_DN || '',
      bindDn: env.WG_LDAP_BIND_DN || '',
      groups: JSON.parse(env.WG_LDAP_GROUPS || '[]'),
    },
  });
  if (environment === 'production' && new URL(defaults.adminOrigin).protocol !== 'https:')
    throw new Error('Produksjon krever HTTPS-adresse');
  const root = env.WG_DATA_ROOT || `runtime/${environment}`;
  const certificateRoot = resolve(
    env.WG_CERTIFICATE_ROOT ||
      (env.WG_ISSUER_KEY_FILE
        ? dirname(env.WG_ISSUER_KEY_FILE)
        : env.WG_FIRMWARE_PUBLIC_KEY_FILE
          ? dirname(env.WG_FIRMWARE_PUBLIC_KEY_FILE)
          : join(root, 'system', 'certificates')),
  );
  return {
    environment,
    role,
    configurationDatabase: env.WG_CONFIG_DB_HOST
      ? {
          host: env.WG_CONFIG_DB_HOST,
          port: Number(env.WG_CONFIG_DB_PORT || 3306),
          user: env.WG_CONFIG_DB_USER || 'weathergateway',
          password: secret('WG_CONFIG_DB_PASSWORD', env),
          database:
            env.WG_CONFIG_DB_DATABASE ||
            (environment === 'production' ? 'weathergateway' : `weathergateway_${environment}`),
          ...(env.WG_CONFIG_DB_TLS === 'true'
            ? {
                ssl: {
                  rejectUnauthorized: true,
                  verifyIdentity: true,
                  minVersion: 'TLSv1.2',
                  ...(env.WG_CONFIG_DB_CA_FILE ? { ca: readFileSync(env.WG_CONFIG_DB_CA_FILE, 'utf8') } : {}),
                },
              }
            : {}),
        }
      : undefined,
    bind,
    port: Number(env.PORT || 8080),
    root,
    certificateRoot,
    issuerKeyFile: env.WG_ISSUER_KEY_FILE || join(certificateRoot, 'client-ca.key'),
    issuerCaFile: env.WG_ISSUER_CA_FILE || join(certificateRoot, 'client-ca.pem'),
    secureCookies,
    defaults,
    adminCidrs: commaSeparated(
      env.WG_ADMIN_CIDRS || '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7',
    ),
    trustedProxies: commaSeparated(env.WG_TRUSTED_PROXIES || ''),
    publicToken: secret('WG_READ_TOKEN', env, { optional: true }),
    publicTokenFile: env.WG_READ_TOKEN_FILE,
    publicAccessFile:
      env.WG_PUBLIC_ACCESS_FILE ||
      (role === 'public'
        ? join(
            env.WG_READ_TOKEN_FILE
              ? dirname(env.WG_READ_TOKEN_FILE)
              : join(certificateRoot, 'roles', 'public'),
            'socket-clients.json',
          )
        : join(certificateRoot, 'roles', 'public', 'socket-clients.json')),
    // A non-empty inline AD password takes precedence over the optional file.
    ldapPassword: env.WG_LDAP_PASSWORD || secret('WG_LDAP_PASSWORD', env, { optional: true }),
    ldapCaFile: env.WG_LDAP_CA_FILE,
    mqttUrl: env.WG_MQTT_URL,
    mqttServerNames: commaSeparated(env.WG_MQTT_SERVER_NAMES || ''),
    mqttCaFile: env.WG_MQTT_CA_FILE,
    mqttCertFile: env.WG_MQTT_CERT_FILE,
    mqttKeyFile: env.WG_MQTT_KEY_FILE,
    databasePasswords: Object.fromEntries(
      Object.entries(env).filter(([name]) => /^WG_DB_PASSWORD(?:_[A-Z0-9_]{1,48})?$/.test(name)),
    ),
    databaseAllowlist: commaSeparated(env.WG_DB_ALLOWED_DATABASES || ''),
    databaseLanEndpoints: commaSeparated(env.WG_DB_LAN_ENDPOINTS ?? env.WG_DB_TUNNEL_ENDPOINTS ?? ''),
    databaseCaFile: env.WG_DB_CA_FILE || undefined,
    databaseCertFile: env.WG_DB_CERT_FILE || undefined,
    databaseKeyFile: env.WG_DB_KEY_FILE || undefined,
    firmwarePublicKeyFile:
      env.WG_FIRMWARE_PUBLIC_KEY_FILE || join(certificateRoot, 'firmware-signing-public.pem'),
  };
}
const seeds = [
  [
    '775147d2-71e6-480d-8827-392ace169300',
    'Skodje',
    'Skodje',
    'Davis Vantage Vue',
    62.50821,
    6.67896,
    85,
    'skodje-wd.txt',
  ],
  [
    '775147d2-71e6-480d-8827-392ace169301',
    'Hahjem',
    'Håhjem',
    'Davis Vantage Pro2',
    62.48861,
    6.70141,
    1,
    'hahjem-wd.txt',
  ],
  [
    '775147d2-71e6-480d-8827-392ace169302',
    'Longva',
    'Longva',
    'Davis Vantage Vue',
    62.68856,
    6.23315,
    13,
    'flemsoy-wd.txt',
  ],
  [
    '775147d2-71e6-480d-8827-392ace169303',
    'Vatne',
    'Vatne',
    'Davis Vantage Pro2',
    62.55781,
    6.62473,
    124,
    'vatne-wd.txt',
  ],
];
export function initialize(store, defaults) {
  store.initialize('notifications', {});
  store.initialize('gateway', defaults);
  // Before the first development login, .env remains the source for the AD
  // bootstrap. Once used or edited through the change flow, settings are owned
  // by the panel. Production never resynchronizes an existing configuration.
  if (
    store.environment === 'development' &&
    defaults.directory.urls.length &&
    defaults.directory.baseDn &&
    defaults.directory.bindDn &&
    defaults.directory.groups.some((group) => group.role === 'administrator')
  ) {
    store.db
      .transaction(() => {
        const current = store.current('gateway');
        if (
          current.revision !== 1 ||
          store.db.prepare("SELECT 1 FROM audit WHERE action='login' LIMIT 1").get() ||
          store.db.prepare("SELECT 1 FROM changes WHERE scope='gateway' LIMIT 1").get() ||
          JSON.stringify(current.value.directory) === JSON.stringify(defaults.directory)
        )
          return;
        store.db
          .prepare("UPDATE configuration SET payload=? WHERE scope='gateway' AND revision=1")
          .run(JSON.stringify({ ...current.value, directory: defaults.directory }));
        store.audit('bootstrap', 'development_directory_initialized', { source: '.env' });
      })
      .immediate();
  }
  for (const [id, key, name, model, latitude, longitude, elevationM, exportName] of seeds) {
    store.initialize(`station:${id}`, {
      id,
      key,
      name,
      model,
      latitude,
      longitude,
      elevationM,
      exportName,
      enabled: true,
      rainCounterMmPerUnit: 0.2,
    });
    store.initialize(`device:${id}`, defaultDevice(id, defaults.publicOrigin, store.environment));
  }
  for (const station of store.stationList()) {
    store.db
      .prepare('INSERT OR IGNORE INTO meta VALUES (?,?)')
      .run(`station_started:${station.value.id}`, String(store.clock()));
    store.initialize(
      `database:${station.value.id}`,
      databaseSchema.parse({ stationId: station.value.id, stationKey: station.value.key }),
    );
    store.initialize(`alarms:${station.value.id}`, { stationId: station.value.id, rules: [] });
  }
}
