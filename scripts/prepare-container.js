// A one-shot Compose service prepares ownership only. It never creates keys,
// changes AD, or needs the Docker socket. Normal application services stay non-root.
import { mkdirSync, chmodSync, chownSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, parse } from 'node:path';

const environment = process.env.WG_ENVIRONMENT;
if (!['production', 'development', 'test'].includes(environment)) throw Error('Ugyldig miljø');
const data = resolve(process.env.WG_DATA_ROOT || '/data'),
  certificates = resolve(process.env.WG_CERTIFICATE_ROOT || '/certificates');
for (const root of [data, certificates]) {
  if (root === parse(root).root) throw Error('Rotstien kan ikke brukes som datamappe');
  let path = root;
  while (path !== parse(path).root) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('Symbolsk lenke avvist');
    path = resolve(path, '..');
  }
}
for (const [path, uid, mode] of [
  [data, 10001, 0o750],
  [join(data, 'system'), 10001, 0o750],
  [join(data, 'system/mqtt'), 10001, 0o750],
  [join(data, 'system/mqtt/data'), 1883, 0o750],
  [join(data, 'public'), 10001, 0o750],
  [certificates, 10001, 0o750],
  [join(certificates, 'roles'), 10001, 0o750],
  ...['worker', 'broker', 'public'].map((role) => [join(certificates, 'roles', role), 10001, 0o750]),
]) {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()))
    throw Error('Ugyldig datamappe');
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
  if (process.platform !== 'win32') chownSync(path, uid, 10001);
}
console.log(
  JSON.stringify({ event: 'runtime_directories_prepared', environment, certificatesGenerated: false }),
);
