import { createServer } from 'node:http';
import { configuration, initialize } from './bootstrap.js';
import { Store } from './store.js';
import { Directory } from './directory.js';
import { controlApp, publicApp } from './app.js';
import { startWorkerWhenReady } from './worker.js';
import { CertificateIssuer, syncAcl, renewalProcessor } from './pki.js';
import { finishBackups, recoverBackups, scheduleBackup } from './backups.js';
import { WeatherDatabase } from './weather-database.js';
import { CertificateManager } from './certificates.js';
import { prepareRuntime } from './runtime-files.js';

process.umask(0o027);
const config = configuration(),
  store = new Store({
    root: config.root,
    environment: config.environment,
    readonly: config.role === 'public',
  });
if (config.role !== 'public') initialize(store, config.defaults);
if (config.role === 'control') prepareRuntime(store);
const certificateManager = config.role === 'control' ? new CertificateManager({ store, config }) : null;
const databaseWriter = config.role === 'public' ? null : new WeatherDatabase(store, config);
const certificates =
  config.role === 'control'
    ? new CertificateIssuer({
        store,
        keyFile: config.issuerKeyFile,
        caFile: config.issuerCaFile,
      })
    : null;
const renewCertificates = config.role === 'control' ? renewalProcessor(store, certificates) : null;
if (config.role === 'control') {
  syncAcl(store);
  recoverBackups(store);
}
let server,
  stopSockets = () => {},
  stopWorker = async () => {},
  timer,
  renewalTask = null;
if (config.role === 'worker') stopWorker = startWorkerWhenReady(store, config, databaseWriter);
else {
  const service =
    config.role === 'public'
      ? publicApp({ store, config })
      : controlApp({
          store,
          config,
          databaseWriter,
          directory: new Directory({ password: config.ldapPassword, caFile: config.ldapCaFile }),
          certificates,
          certificateManager,
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
  let backupCheck = 0;
  timer = setInterval(() => {
    try {
      store.sweep();
      certificateManager.sweep();
      syncAcl(store);
      if (++backupCheck % 60 === 0) scheduleBackup(store);
      if (!renewalTask && certificateManager.pending()?.type !== 'ca')
        renewalTask = renewCertificates()
          .catch((error) =>
            console.error(
              JSON.stringify({ event: 'certificate_renewal_failed', code: error.code || error.name }),
            ),
          )
          .finally(() => {
            renewalTask = null;
          });
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
  await renewalTask;
  stopSockets();
  await stopWorker();
  await databaseWriter?.close();
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
