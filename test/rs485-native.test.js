import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { deviceSchema } from '../server/schema.js';
import { deviceProfile } from '../shared/device-hardware.js';
const compiler = process.env.WG_FIRMWARE_HOST_CC || resolve('.tools/verification/tcc/tcc/tcc.exe');
test(
  'actual native RS485 code holds DE low, frames on hardware idle and rejects noise, partial bursts and UART faults',
  { skip: !existsSync(compiler) },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'wg-rs485-native-'));
    try {
      const exe = join(root, 'capture.exe');
      execFileSync(compiler, ['-Itest/rs485-stubs', '-Ifirmware/main', 'test/rs485-native.c', '-o', exe], {
        windowsHide: true,
        stdio: 'pipe',
        timeout: 30000,
      });
      assert.match(
        execFileSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 5000 }),
        /native RS485 framing/,
      );
    } finally {
      if (!relative(resolve(tmpdir()), root).startsWith('..')) rmSync(root, { recursive: true, force: true });
    }
  },
);
test('RS485 ISS profile fixes the documented 4800 baud and rejects unsafe or conflicting GPIOs', () => {
  const config = deviceProfile(
    { stationId: '775147d2-71e6-480d-8827-392ace169301', mqttHost: 'gateway.invalid', mqttPort: 8883 },
    'davis-iss-rs485',
  );
  assert.equal(deviceSchema.parse(config).interface, 'davis-iss-rs485');
  for (const pin of [0, 2, 5, 6, 12, 15, 34])
    assert.equal(deviceSchema.safeParse({ ...config, rs485De: pin }).success, false);
  assert.equal(deviceSchema.safeParse({ ...config, rs485De: config.uartRx }).success, false);
  assert.equal(deviceSchema.safeParse({ ...config, uartBaud: '4800' }).success, true);
  assert.equal(deviceSchema.safeParse({ ...config, uartBaud: '19200' }).success, false);
});
