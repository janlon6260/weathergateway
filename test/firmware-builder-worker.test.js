import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

const python = process.env.WG_FIRMWARE_PYTHON || 'python';
const available = spawnSync(python, ['--version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(50);
  }
  throw Error('Worker did not finish');
}
for (const cancelled of [false, true])
  test(
    `real builder worker ${cancelled ? 'cancels its entire compiler process tree' : 'redacts failed compiler output and removes provisioning files'}`,
    { skip: !available, timeout: 25000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'wg-builder-test-')),
        jobs = join(root, 'jobs'),
        work = join(root, 'work'),
        template = join(root, 'template'),
        sdk = join(root, 'sdk');
      for (const path of [jobs, work, join(template, 'main'), join(sdk, 'tools')])
        mkdirSync(path, { recursive: true });
      const buildId = randomUUID(),
        job = join(jobs, buildId),
        marker = join(root, 'leaked-child');
      mkdirSync(job);
      const password = 'test-password-DO-NOT-LOG',
        privateKey = 'TEST-PRIVATE-KEY-LINE';
      writeFileSync(
        join(job, 'request.json'),
        JSON.stringify({
          format: 1,
          environment: 'test',
          buildId,
          files: {
            'provisioning.h': `#define WG_WIFI_PASSWORD ${JSON.stringify(password)}\n`,
            'device.key': privateKey,
            'device.pem': 'test-certificate',
            'ca.pem': 'test-ca',
          },
        }),
      );
      const markerLiteral = JSON.stringify(marker);
      writeFileSync(
        join(sdk, 'tools/idf.py'),
        cancelled
          ? `import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',${JSON.stringify(`import time,pathlib; time.sleep(4); pathlib.Path(${markerLiteral}).write_text('leaked')`)}])\nprint('compiler-started',flush=True)\ntime.sleep(30)\n`
          : `print(${JSON.stringify(password)},flush=True)\nprint(${JSON.stringify(privateKey)},flush=True)\nraise RuntimeError('test compiler failure')\n`,
      );
      const worker = spawn(python, ['builder/worker.py'], {
        env: {
          ...process.env,
          IDF_PYTHON_ENV_PATH: '',
          IDF_PATH: sdk,
          WG_BUILD_JOBS: jobs,
          WG_BUILD_WORK: work,
          WG_FIRMWARE_TEMPLATE: template,
          WG_ENVIRONMENT: 'test',
        },
        windowsHide: true,
        stdio: 'ignore',
      });
      t.after(async () => {
        worker.kill('SIGTERM');
        await Promise.race([once(worker, 'exit'), sleep(3000)]);
        const rel = relative(resolve(tmpdir()), resolve(root));
        if (!rel.startsWith('..') && rel.startsWith('wg-builder-test-'))
          rmSync(root, { recursive: true, force: true });
      });
      await until(() => existsSync(join(job, 'progress.json')));
      if (cancelled) {
        await until(() => readFileSync(join(job, 'progress.json'), 'utf8').includes('compiler-started'));
        writeFileSync(join(job, 'cancel'), 'cancel');
        await until(() => !existsSync(join(work, 'project/main/device.key')));
        await sleep(4500);
        assert.equal(existsSync(marker), false, 'Compiler descendants must not survive cancellation');
        assert.equal(existsSync(join(job, 'finished.json')), true);
      } else {
        await until(() => existsSync(join(job, 'result.json')));
        const log = JSON.parse(readFileSync(join(job, 'progress.json'), 'utf8')).log;
        assert.ok(log.includes('[skjult]'));
        assert.equal(log.includes(password), false);
        assert.equal(log.includes(privateKey), false);
        assert.ok(log.includes('RuntimeError'));
        assert.equal(JSON.parse(readFileSync(join(job, 'result.json'), 'utf8')).error, 'build_failed');
        await until(() => !existsSync(join(work, 'project/main/provisioning.h')));
      }
    },
  );
