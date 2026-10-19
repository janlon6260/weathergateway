import { createServer } from 'node:http';
import { configuration, initialize } from './bootstrap.js';
import { Store } from './store.js';
import { Directory } from './directory.js';
import { controlApp, publicApp } from './app.js';
import { startWorker } from './worker.js';
import { CertificateIssuer, syncAcl } from './pki.js';
import { finishBackups, recoverBackups } from './backups.js';

process.umask(0o027);
const config = configuration(),
  store = new Store({
    root: config.root,
    environment: config.environment,
    readonly: config.role === 'public',
  });
if (config.role !== 'public') initialize(store, config.defaults);
if (config.role === 'control') {
  syncAcl(store);
  recoverBackups(store);
}
let server,
  stopSockets = () => {},
  stopWorker = async () => {},
  timer;
if (config.role === 'worker') stopWorker = startWorker(store, config);
else {
  const service =
    config.role === 'public'
      ? publicApp({ store, config })
      : controlApp({
          store,
          config,
          directory: new Directory({ password: config.ldapPassword, caFile: config.ldapCaFile }),
          certificates: process.env.WG_ISSUER_KEY_FILE
            ? new CertificateIssuer({
                store,
                keyFile: process.env.WG_ISSUER_KEY_FILE,
                caFile: process.env.WG_ISSUER_CA_FILE,
              })
            : null,
        });
  server = createServer(service.app);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  if (service.attachSockets) stopSockets = service.attachSockets(server);
  server.listen(config.port, config.bind, () =>
    console.log(
      JSON.stringify({
        event: 'listening',
        role: config.role,
        environment: config.environment,
        bind: config.bind,
        port: config.port,
      }),
    ),
  );
}
if (config.role === 'control') {
  timer = setInterval(() => {
    try {
      store.sweep();
      syncAcl(store);
    } catch (e) {
      console.error(JSON.stringify({ event: 'watchdog_failed', code: e.code || e.name }));
    }
  }, 1000);
  timer.unref();
}
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  stopSockets();
  await stopWorker();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await finishBackups(store);
  store.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
