// Produces ordinary Compose JSON (also valid YAML), with literal, separate host
// mounts per environment. No development variable can redirect a production mount.
import { writeFileSync } from 'node:fs';
for (const env of ['production', 'development']) {
  const root = `/data/req/weathergateway/${env}`,
    secrets = `/data/req/weathergateway/secrets/${env}`,
    port = env === 'production' ? 18080 : 18090;
  const bind = (source, target, read_only = true, create = false) => ({
    type: 'bind',
    source,
    target,
    read_only,
    bind: { create_host_path: create },
  });
  const base = {
    image: '${WG_IMAGE:-janlon6260/weathergateway:latest}',
    restart: 'unless-stopped',
    init: true,
    user: '10001:10001',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    tmpfs: ['/tmp:rw,noexec,nosuid,size=64m'],
    mem_limit: '512m',
    cpus: '1.5',
    logging: { driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } },
  };
  const shared = {
    WG_ENVIRONMENT: env,
    WG_DATA_ROOT: '/data',
    WG_BIND: '0.0.0.0',
    PORT: '8080',
    WG_ADMIN_ORIGIN: '${WG_ADMIN_ORIGIN}',
    WG_PUBLIC_ORIGIN: '${WG_PUBLIC_ORIGIN}',
    WG_DEVELOPMENT_ORIGIN: '${WG_DEVELOPMENT_ORIGIN}',
    WG_PRODUCTION_ORIGIN: '${WG_PRODUCTION_ORIGIN}',
  };
  const databases = {
    WG_DB_ALLOWED_DATABASES: '${WG_DB_ALLOWED_DATABASES:-}',
    WG_DB_LAN_ENDPOINTS: '${WG_DB_LAN_ENDPOINTS:-}',
    WG_DB_PASSWORD: '${WG_DB_PASSWORD:-}',
    WG_DB_PASSWORD_SKODJE: '${WG_DB_PASSWORD_SKODJE:-}',
    WG_DB_PASSWORD_HAHJEM: '${WG_DB_PASSWORD_HAHJEM:-}',
    WG_DB_PASSWORD_LONGVA: '${WG_DB_PASSWORD_LONGVA:-}',
    WG_DB_PASSWORD_VATNE: '${WG_DB_PASSWORD_VATNE:-}',
    WG_DB_CA_FILE: '${WG_DB_CA_FILE:-}',
    WG_DB_CERT_FILE: '${WG_DB_CERT_FILE:-}',
    WG_DB_KEY_FILE: '${WG_DB_KEY_FILE:-}',
  };
  const control = {
    ...base,
    environment: {
      ...shared,
      WG_ROLE: 'control',
      WG_CERTIFICATE_ROOT: '/run/secrets',
      WG_MQTT_SERVER_NAMES: '${WG_MQTT_SERVER_NAMES:-}',
      ...databases,
      WG_ADMIN_CIDRS: '${WG_ADMIN_CIDRS}',
      WG_TRUSTED_PROXIES: '${WG_TRUSTED_PROXIES}',
      WG_LDAP_URLS: '${WG_LDAP_URLS}',
      WG_LDAP_BASE_DN: '${WG_LDAP_BASE_DN}',
      WG_LDAP_BIND_DN: '${WG_LDAP_BIND_DN}',
      WG_LDAP_GROUPS: '${WG_LDAP_GROUPS}',
      WG_LDAP_PASSWORD: '${WG_LDAP_PASSWORD:-}',
      WG_LDAP_PASSWORD_FILE: '/run/secrets/ldap-password',
      WG_LDAP_CA_FILE: '/run/secrets/ad-ca.pem',
      WG_ISSUER_KEY_FILE: '/run/secrets/client-ca.key',
      WG_ISSUER_CA_FILE: '/run/secrets/client-ca.pem',
      WG_FIRMWARE_PUBLIC_KEY_FILE: '/run/secrets/firmware-signing-public.pem',
    },
    volumes: [bind(root, '/data', false), bind(secrets, '/run/secrets', false)],
    depends_on: { prepare: { condition: 'service_completed_successfully' } },
    ports: ['${WG_ADMIN_BIND_IP:?Sett en privat LAN-adresse}:' + (port + 1) + ':8080'],
    networks: ['control'],
  };
  const worker = {
    ...base,
    environment: {
      ...shared,
      WG_ROLE: 'worker',
      ...databases,
      WG_MQTT_URL: 'mqtts://broker:8883',
      WG_MQTT_CA_FILE: '/run/secrets/client-ca.pem',
      WG_MQTT_CERT_FILE: '/run/secrets/worker.pem',
      WG_MQTT_KEY_FILE: '/run/secrets/worker.key',
    },
    volumes: [bind(root, '/data', false), bind(`${secrets}/roles/worker`, '/run/secrets')],
    depends_on: { control: { condition: 'service_healthy' }, broker: { condition: 'service_started' } },
    networks: ['ingest'],
  };
  const publicApi = {
    ...base,
    user: '10002:10001',
    environment: { ...shared, WG_ROLE: 'public', WG_READ_TOKEN_FILE: '/run/credentials/read-token' },
    volumes: [bind(`${root}/public`, '/data'), bind(`${secrets}/roles/public`, '/run/credentials')],
    ports: [`127.0.0.1:${port}:8080`],
    depends_on: { control: { condition: 'service_healthy' } },
    networks: ['public'],
  };
  const broker = {
    image: 'eclipse-mosquitto:2.1.2-alpine',
    restart: 'unless-stopped',
    user: '1883:10001',
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    tmpfs: ['/tmp:rw,noexec,nosuid,size=16m'],
    mem_limit: '128m',
    entrypoint: ['/bin/sh', '/mosquitto/config/broker-entrypoint.sh'],
    ports: ['${WG_MQTT_BIND_IP:-0.0.0.0}:' + (env === 'production' ? 8883 : 8884) + ':8883'],
    volumes: [
      bind(`${root}/system/mqtt`, '/mosquitto/config'),
      bind(`${root}/system/mqtt/data`, '/mosquitto/data', false),
      bind(`${secrets}/roles/broker`, '/mosquitto/certs'),
    ],
    healthcheck: {
      test: ['CMD-SHELL', 'kill -0 "$(cat /tmp/mosquitto.pid)"'],
      interval: '10s',
      timeout: '3s',
      retries: 3,
    },
    logging: base.logging,
    networks: ['ingest'],
    depends_on: { control: { condition: 'service_healthy' } },
  };
  const prepare = {
    ...base,
    user: '0:0',
    restart: 'no',
    cap_add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
    command: ['node', 'scripts/prepare-container.js'],
    environment: { WG_ENVIRONMENT: env, WG_DATA_ROOT: '/data', WG_CERTIFICATE_ROOT: '/certificates' },
    volumes: [bind(root, '/data', false, true), bind(secrets, '/certificates', false, true)],
    healthcheck: { disable: true },
    network_mode: 'none',
  };
  writeFileSync(
    `deploy/compose.${env}.json`,
    JSON.stringify(
      {
        name: `wg-${env}`,
        services: { prepare, control, worker, public: publicApi, broker },
        networks: { control: {}, public: {}, ingest: {} },
      },
      null,
      2,
    ) + '\n',
  );
}
