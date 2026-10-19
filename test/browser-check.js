// Optional visual/integration QA. Uses an existing Playwright installation.
// No development authentication mode is added to the deployable application.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { configuration, initialize } from '../server/bootstrap.js';
import { controlApp } from '../server/app.js';
import { directory, observation } from './helpers.js';
import { ingest } from '../server/observations.js';

const packagePath = process.argv[2];
if (!packagePath) throw new Error('Oppgi package.json-stien til en eksisterende Playwright-installasjon');
if (process.argv[3]) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(process.argv[3]);
const require = createRequire(resolve(packagePath)),
  { webkit } = require('@playwright/test');
const root = mkdtempSync(join(tmpdir(), 'wg-browser-'));
const store = new Store({ root, environment: 'test' });
let browser, server;
try {
  const config = configuration({
    WG_ENVIRONMENT: 'test',
    WG_ADMIN_ORIGIN: 'http://127.0.0.1:18761',
    WG_ALLOW_LOCAL_HTTP: 'true',
  });
  initialize(store, config.defaults);
  for (const [i, s] of store.stationList().entries())
    ingest(
      store,
      s.value.id,
      observation(s.value.id, Date.now(), {
        measurements: {
          temperatureC: 8 + i,
          humidityPct: 74,
          pressureHpa: 1008.4,
          windSpeedMs: i,
          windMeanMs: i / 2,
          windGustMs: i + 3,
          rainTodayMm: 2.4,
        },
      }),
    );
  server = createServer(controlApp({ store, config, directory: directory() }).app);
  await new Promise((resolve) => server.listen(18761, '127.0.0.1', resolve));
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('page-error', e.message);
  });
  page.on('requestfailed', (r) => console.log('request-failed', r.url(), r.failure()?.errorText));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('browser-console', msg.text());
  });
  await page.goto('http://127.0.0.1:18761');
  await page.getByLabel('Brukernavn').fill('test');
  await page.getByLabel('Passord', { exact: true }).fill('valid-test-password');
  await page.getByRole('button', { name: 'Logg inn', exact: false }).click();
  await page.getByRole('heading', { name: 'Oversikt', exact: true }).waitFor();
  await page.getByText('8.0 °C', { exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 4);
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/admin-desktop.png', fullPage: true, caret: 'initial' });
  await page.getByRole('navigation').getByRole('button', { name: 'Enheter' }).click();
  await page.getByRole('button', { name: 'Endre innstillinger' }).first().click();
  await page.getByLabel('ISS sender-ID').selectOption('3');
  assert.equal(await page.getByLabel('SPI SCK GPIO').inputValue(), '18');
  await page.screenshot({ path: 'artifacts/admin-radio.png', fullPage: true, caret: 'initial' });
  await page.getByRole('button', { name: 'Lagre som utkast' }).click();
  await page.getByRole('button', { name: 'Test endringen' }).waitFor();
  const radioChange = store.changes().find((c) => c.scope.startsWith('device:') && c.state === 'draft');
  assert.equal(radioChange.candidate.transmitterId, 3);
  assert.equal(store.current(radioChange.scope).value.transmitterId, 1);
  await page.getByRole('button', { name: 'Avbryt', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Innstillinger' }).click();
  await page.getByLabel('Frist for bekreftelse (sekunder)').fill('120');
  await page.getByRole('button', { name: 'Lagre som utkast' }).click();
  await page.getByRole('button', { name: 'Test endringen' }).click();
  await page.getByRole('button', { name: 'Gjør gjeldende' }).click();
  await page.getByText('Gjeldende', { exact: true }).waitFor();
  assert.equal(store.current('gateway').value.confirmationSeconds, 120);
  await page.getByRole('navigation').getByRole('button', { name: 'Oversikt' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/admin-mobile.png', fullPage: true, caret: 'initial' });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'Browser QA passed: AD-form, login, four stations, realtime values, settings trial and confirmation, desktop/mobile.',
  );
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  store.close();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (!rel.startsWith('..') && rel.startsWith('wg-browser-')) rmSync(root, { recursive: true, force: true });
}
