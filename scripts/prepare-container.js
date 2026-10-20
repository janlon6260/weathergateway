// Prepare directories without creating keys or changing AD. When run non-root,
// preserve that process's UID/GID and require the host mounts to be owned by it.
// Root mode retains ownership for the earlier Compose layout during upgrades.
import { mkdirSync, chmodSync, chownSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, parse } from 'node:path';

const environment = process.env.WG_ENVIRONMENT;
if (!['production', 'development', 'test'].includes(environment)) throw Error('Ugyldig miljø');
const data = resolve(process.env.WG_DATA_ROOT || '/data'),
  certificates = resolve(process.env.WG_CERTIFICATE_ROOT || '/certificates');
const currentUid = process.getuid?.(),
  currentGid = process.getgid?.();
const rootMode = currentUid === 0;
const targetUid = currentUid > 0 ? currentUid : 10001;
const targetGid = !rootMode && currentGid !== undefined ? currentGid : 10001;
for (const root of [data, certificates]) {
  if (root === parse(root).root) throw Error('Rotstien kan ikke brukes som datamappe');
  let path = root;
  while (path !== parse(path).root) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('Symbolsk lenke avvist');
    path = resolve(path, '..');
  }
}
for (const [path, uid, mode] of [
  [data, targetUid, 0o750],
  [join(data, 'system'), targetUid, 0o750],
  [join(data, 'system/mqtt'), targetUid, 0o750],
  [join(data, 'system/mqtt/data'), rootMode ? 1883 : targetUid, 0o750],
  [join(data, 'public'), targetUid, 0o750],
  [certificates, targetUid, 0o750],
  [join(certificates, 'roles'), targetUid, 0o750],
  ...['worker', 'broker', 'public'].map((role) => [join(certificates, 'roles', role), targetUid, 0o750]),
]) {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()))
    throw Error('Ugyldig datamappe');
  mkdirSync(path, { recursive: true, mode });
  if (process.platform !== 'win32') {
    const owner = lstatSync(path);
    if (rootMode) chownSync(path, uid, targetGid);
    else if (owner.uid !== uid || owner.gid !== targetGid)
      throw Error(
        `Hostmappen ${path} må eies av ${uid}:${targetGid}. Endre eierskap på hosten før oppstart.`,
      );
  }
  chmodSync(path, mode);
}
console.log(
  JSON.stringify({
    event: 'runtime_directories_prepared',
    environment,
    uid: targetUid,
    gid: targetGid,
    certificatesGenerated: false,
  }),
);
