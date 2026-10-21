import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
export function prepareBuilder(dataRoot, { sourceRoot = resolve('.') } = {}) {
  const vendor = join(sourceRoot, 'builder', 'vendor'),
    manifest = JSON.parse(readFileSync(join(vendor, 'manifest.json'), 'utf8'));
  for (const [name, digest] of Object.entries(manifest.files)) {
    const path = resolve(vendor, name),
      rel = relative(vendor, path);
    if (
      rel.startsWith('..') ||
      lstatSync(path).isSymbolicLink() ||
      createHash('sha256').update(readFileSync(path)).digest('hex') !== digest
    )
      throw new Error('Firmwareavhengighetenes kontrollsummer stemmer ikke');
  }
  const root = join(dataRoot, 'system', 'firmware-builder-runtime'),
    project = join(root, 'firmware'),
    main = join(project, 'main');
  mkdirSync(main, { recursive: true, mode: 0o750 });
  copyFileSync(join(sourceRoot, 'builder', 'worker.py'), join(root, 'worker.py'));
  for (const name of ['CMakeLists.txt', 'partitions.csv', 'sdkconfig.defaults'])
    copyFileSync(join(sourceRoot, 'firmware', name), join(project, name));
  for (const entry of readdirSync(join(sourceRoot, 'firmware', 'main'), { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (
      entry.name === 'provisioning.h' ||
      !(/\.(?:c|h)$/.test(entry.name) || entry.name === 'CMakeLists.txt')
    )
      continue;
    copyFileSync(join(sourceRoot, 'firmware', 'main', entry.name), join(main, entry.name));
  }
  for (const part of ['mqtt', 'cjson']) {
    const destination = join(project, 'components', part);
    mkdirSync(destination, { recursive: true, mode: 0o750 });
    cpSync(join(vendor, part), destination, {
      recursive: true,
      filter: (path) => {
        if (lstatSync(path).isSymbolicLink())
          throw new Error('Symbolsk lenke er ikke tillatt i firmwarekildene');
        return true;
      },
    });
  }
  // Templates never contain a station's keys or Wi-Fi settings.
  for (const name of ['provisioning.h', 'device.pem', 'device.key', 'ca.pem'])
    if (existsSync(join(main, name))) throw new Error('Firmwaremalen inneholder enhetsopplysninger');
  writeFileSync(
    join(root, 'source-version.json'),
    JSON.stringify({ format: 1, mqtt: manifest.mqtt, cjson: manifest.cjson }),
    { mode: 0o640 },
  );
  return root;
}
