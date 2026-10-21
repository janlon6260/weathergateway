import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const localTcc = resolve('.tools/verification/tcc/tcc/tcc.exe');
const compiler =
  process.env.WG_FIRMWARE_HOST_CC ||
  (process.platform === 'win32' && existsSync(localTcc)
    ? localTcc
    : process.platform !== 'win32' && spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0
      ? 'cc'
      : null);
for (const [source, expected] of [
  ['radio-lifecycle.c', 'radio lifecycle'],
  ['radio-reception.c', 'radio reception'],
  ['radio-receiver.c', 'radio task'],
  ['mqtt-lifecycle.c', 'MQTT lifecycle'],
  ['config-storage.c', 'OTA configuration storage'],
])
  test(`actual firmware ${source} handles boot failures and recovery`, { skip: !compiler }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'wg-firmware-native-'));
    try {
      const output = join(directory, process.platform === 'win32' ? 'check.exe' : 'check');
      execFileSync(compiler, ['-Itest/radio-stubs', '-Ifirmware/main', `test/${source}`, '-o', output], {
        windowsHide: true,
        stdio: 'pipe',
        timeout: 30000,
      });
      assert.ok(
        execFileSync(output, [], { windowsHide: true, encoding: 'utf8', timeout: 10000 }).includes(expected),
      );
    } finally {
      const rel = relative(resolve(tmpdir()), resolve(directory));
      if (!rel.startsWith('..') && rel.startsWith('wg-firmware-native-'))
        rmSync(directory, { recursive: true, force: true });
    }
  });
