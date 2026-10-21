import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBuilder } from '../scripts/prepare-builder.js';
test('offline builder receives byte-verified sources and no provisioning keys or network dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-builder-template-'));
  try {
    const runtime = prepareBuilder(root),
      main = join(runtime, 'firmware', 'main');
    assert.ok(existsSync(join(main, 'wg_usb_health.c')));
    for (const name of ['provisioning.h', 'device.key', 'device.pem', 'ca.pem', 'idf_component.yml'])
      assert.equal(existsSync(join(main, name)), false);
    const component = readFileSync(join(runtime, 'firmware', 'components', 'mqtt', 'CMakeLists.txt'), 'utf8');
    assert.match(component, /mqtt_client/);
    assert.ok(readdirSync(join(runtime, 'firmware', 'components', 'cjson')).includes('LICENSE'));
    assert.match(readFileSync(join(main, 'wg_usb_health.c'), 'utf8'), /WG_BOOT_READY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('publish workflow only builds thin application images with native runners and bounded job budgets', () => {
  const workflow = readFileSync('.github/workflows/dockerhub.yml', 'utf8');
  assert.match(workflow, /ubuntu-24\.04-arm/);
  assert.match(workflow, /timeout-minutes: 2/);
  assert.match(workflow, /timeout-minutes: 1/);
  assert.doesNotMatch(
    workflow,
    /setup-qemu|upload-artifact|npm (?:run )?test|node --test|file: .*builder\/Dockerfile/,
  );
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /imagetools create/);
  assert.match(workflow, /environment: prod/);
  assert.match(workflow, /secrets\.DOCKERHUB_TOKEN/);
});
