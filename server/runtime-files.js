import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { syncAcl } from './pki.js';
import { publicProjection } from './public-projection.js';

export const brokerConfiguration = `listener 8883
protocol mqtt
allow_anonymous false
require_certificate true
use_identity_as_username true
use_username_as_clientid true
cafile /mosquitto/certs/client-ca.pem
certfile /mosquitto/certs/server.pem
keyfile /mosquitto/certs/server.key
tls_version tlsv1.2
acl_file /mosquitto/config/acl
persistence true
persistence_location /mosquitto/data/
autosave_interval 30
log_dest stdout
max_connections 100
max_packet_size 32768
message_size_limit 16384
max_queued_messages 100
max_inflight_messages 20
`;

export function prepareRuntime(store) {
  const directory = store.safe('system', 'mqtt');
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  syncAcl(store);
  for (const [name, contents] of [
    ['mosquitto.conf', brokerConfiguration],
    ['broker-entrypoint.sh', readFileSync(new URL('../deploy/broker-entrypoint.sh', import.meta.url))],
  ]) {
    const path = join(directory, name);
    if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(contents))) {
      writeFileSync(path + '.tmp', contents, { mode: name.endsWith('.sh') ? 0o750 : 0o640, flush: true });
      renameSync(path + '.tmp', path);
    }
  }
  const projection = publicProjection(store);
  projection.sync();
  projection.close();
  chmodSync(store.safe('system'), 0o750);
}
