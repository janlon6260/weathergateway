import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { Store, Rejected } from '../server/store.js';
import { configuration, initialize } from '../server/bootstrap.js';

export function setup(t, environment = 'test') {
  const temp = resolve(mkdtempSync(join(tmpdir(), 'wg-test-'))),
    config = configuration({
      WG_ENVIRONMENT: environment,
      WG_ADMIN_ORIGIN: 'http://localhost:5173',
      ...(environment !== 'production' ? { WG_ALLOW_LOCAL_HTTP: 'true' } : {}),
    });
  let now = Date.UTC(2026, 9, 19, 10, 0, 0);
  const store = new Store({ root: temp, environment, clock: () => now });
  initialize(store, config.defaults);
  t.after(() => {
    store.close();
    const rel = relative(resolve(tmpdir()), temp);
    if (!rel.startsWith('..') && rel.startsWith('wg-test-')) rmSync(temp, { recursive: true, force: true });
  });
  return { store, config, tick: (ms) => (now += ms), now: () => now };
}
export const principal = (roles) => ({
  sid: 'S-1-5-21-1-2-3-1001',
  dn: 'CN=Test,DC=example,DC=local',
  username: 'test',
  name: 'Test User',
  roles,
  groups: ['S-1-5-21-1-2-3-2001'],
});
export function directory(roles = ['administrator']) {
  return {
    async authenticate(username, password) {
      if (username !== 'test' || password !== 'valid-test-password')
        throw new Rejected('Innlogging avvist', 401);
      return principal(roles);
    },
    async refresh(user) {
      return { ...user, roles };
    },
    async probe(_principal, settings) {
      if (settings.baseDn === 'bad') throw new Rejected('AD-test feilet');
      return { directory: 'ok' };
    },
  };
}
export function observation(stationId, observedAt, overrides = {}) {
  return {
    version: 1,
    stationId,
    bootId: '402500fa-a03b-4dcf-af73-11109f9b8329',
    sequence: 1,
    observedAt: new Date(observedAt).toISOString(),
    firmware: 'test-1',
    sensorContact: true,
    measurements: {
      temperatureC: 20,
      humidityPct: 50,
      pressureHpa: 1013.25,
      windSpeedMs: 5,
      windMeanMs: 4,
      windGustMs: 7,
      windDirectionDeg: 359,
      rainTodayMm: 3.4,
      rainRateMmH: 0,
    },
    ...overrides,
  };
}
