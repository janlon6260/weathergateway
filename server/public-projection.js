import { chmodSync, mkdirSync } from 'node:fs';
import { DateTime } from 'luxon';
import { Store } from './store.js';
import { exportStation } from './observations.js';
import { invalidateWeatherCache } from './weather-analytics.js';

// The internet-facing process receives a weather-only read model. It cannot
// open the control database, AD configuration, sessions, commands or raw files.
export function publicProjection(source) {
  const root = source.safe('public');
  mkdirSync(root, { recursive: true, mode: 0o750 });
  const destination = new Store({ root, environment: source.environment, clock: source.clock });
  for (const [path, mode] of [
    ['.environment', 0o640],
    ['system', 0o750],
    ['system/gateway.sqlite3', 0o640],
  ])
    chmodSync(destination.safe(path), mode);
  const generation =
    source.db.prepare("SELECT value FROM meta WHERE key='projection_generation'").get()?.value || '1';
  if (
    destination.db.prepare("SELECT value FROM meta WHERE key='projection_generation'").get()?.value !==
    generation
  ) {
    destination.db
      .transaction(() => {
        destination.db.exec(
          'DELETE FROM observations; DELETE FROM rollups; DELETE FROM rain_state; DELETE FROM weather_bins; DELETE FROM weather_segments; DELETE FROM rain_increments; DELETE FROM configuration',
        );
        destination.db
          .prepare(
            "INSERT INTO meta VALUES ('projection_watermark','0') ON CONFLICT(key) DO UPDATE SET value='0'",
          )
          .run();
        destination.db
          .prepare(
            "INSERT INTO meta VALUES ('projection_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(generation);
      })
      .immediate();
  }
  let watermark = Number(
    destination.db.prepare("SELECT value FROM meta WHERE key='projection_watermark'").get()?.value || 0,
  );
  destination.db.prepare('ATTACH DATABASE ? AS upstream').run(source.safe('system', 'gateway.sqlite3'));
  function sync() {
    const initial = watermark === 0,
      threshold = source.clock() - 3 * 3600000;
    const recent = source.db
      .prepare(
        'SELECT rowid,station_id,body,observed_at,received_at,boot_id,sequence FROM observations WHERE received_at>=? ORDER BY received_at LIMIT 50000',
      )
      .all(Math.max(threshold, watermark - 1000));
    if (initial)
      for (const s of source.stationList()) {
        const r = source.db
          .prepare(
            'SELECT rowid,station_id,body,observed_at,received_at,boot_id,sequence FROM observations WHERE station_id=? ORDER BY observed_at DESC,received_at DESC LIMIT 1',
          )
          .get(s.value.id);
        if (r && !recent.some((row) => row.rowid === r.rowid)) recent.push(r);
      }
    const periods = new Set();
    destination.db
      .transaction(() => {
        const gateway = source.current('gateway');
        destination.db
          .prepare(
            'INSERT INTO configuration VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',
          )
          .run(
            'gateway',
            gateway.revision,
            JSON.stringify({
              publicOrigin: gateway.value.publicOrigin,
              warningSeconds: gateway.value.warningSeconds,
              downSeconds: gateway.value.downSeconds,
            }),
          );
        const put = destination.db.prepare(
          'INSERT INTO configuration VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload',
        );
        for (const current of source.stationList()) {
          const s = source.confirmedConfiguration(current.scope);
          put.run(s.scope, s.revision, JSON.stringify(s.value));
        }
        const weatherStart = Math.max(
          source.clock() - 3600000,
          recent.length ? Math.min(...recent.map((r) => r.observed_at)) - 300000 : source.clock() - 300000,
        );
        destination.db
          .prepare('DELETE FROM weather_segments WHERE start_at>=? OR end_at<?')
          .run(weatherStart, source.clock() - 3600000);
        destination.db
          .prepare(
            'INSERT OR REPLACE INTO main.weather_segments SELECT * FROM upstream.weather_segments WHERE start_at>=?',
          )
          .run(weatherStart);
        destination.db
          .prepare(
            'INSERT OR REPLACE INTO main.rain_increments SELECT * FROM upstream.rain_increments WHERE end_at>=?',
          )
          .run(initial ? source.clock() - 48 * 3600000 : weatherStart);
        if (initial)
          destination.db.exec(
            'INSERT OR IGNORE INTO main.rain_increments SELECT * FROM upstream.rain_increments AS r WHERE amount_mm>0 AND end_at=(SELECT MAX(end_at) FROM upstream.rain_increments WHERE station_id=r.station_id AND amount_mm>0)',
          );
        for (const r of recent) {
          const b = JSON.parse(r.body);
          delete b.source;
          delete b.configurationHash;
          delete b.certificateId;
          delete b.firmwareReleaseId;
          destination.db
            .prepare('INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?)')
            .run(r.station_id, r.boot_id, r.sequence, r.observed_at, r.received_at, JSON.stringify(b));
          periods.add(DateTime.fromMillis(r.observed_at, { zone: 'Europe/Oslo' }).toISODate());
          periods.add(new Date(Math.floor(r.observed_at / 3600000) * 3600000).toISOString());
        }
        const copyRollups = (where) =>
          destination.db.exec(
            `INSERT INTO main.rollups SELECT * FROM upstream.rollups ${where} ON CONFLICT(station_id,period,metric) DO UPDATE SET minimum=excluded.minimum,maximum=excluded.maximum,total=excluded.total,samples=excluded.samples,min_at=excluded.min_at,max_at=excluded.max_at`,
          );
        if (initial) copyRollups('WHERE 1');
        else
          for (const period of periods) {
            // Periods are generated by DateTime/Date above and contain only digits,
            // dash, colon, dot, T and Z; never supplied by a request.
            if (!/^[0-9T:Z.\-]+$/.test(period)) throw new Error('Ugyldig aggregatperiode');
            copyRollups(`WHERE period='${period}'`);
          }
        if (initial)
          destination.db.exec('INSERT OR REPLACE INTO main.weather_bins SELECT * FROM upstream.weather_bins');
        else
          for (const day of [...periods].filter((p) => p.length === 10)) {
            const start = DateTime.fromISO(day, { zone: 'Europe/Oslo' }).startOf('day');
            destination.db
              .prepare(
                'INSERT OR REPLACE INTO main.weather_bins SELECT * FROM upstream.weather_bins WHERE hour>=? AND hour<?',
              )
              .run(start.toMillis() - 3600000, start.plus({ days: 1 }).toMillis());
          }
        const rain = 'INSERT INTO main.rain_state SELECT * FROM upstream.rain_state WHERE ';
        const updateRain =
          ' ON CONFLICT(station_id,day) DO UPDATE SET last_at=excluded.last_at,last_counter=excluded.last_counter,unit=excluded.unit,total_mm=excluded.total_mm,resets=excluded.resets';
        if (initial) destination.db.exec(rain + '1' + updateRain);
        else
          for (const day of [...periods].filter((p) => p.length === 10))
            destination.db.prepare(rain + 'day=?' + updateRain).run(day);
        for (const s of source.stationList()) {
          const last = destination.db
            .prepare(
              'SELECT rowid FROM observations WHERE station_id=? ORDER BY observed_at DESC,received_at DESC LIMIT 1',
            )
            .get(s.value.id);
          if (last)
            destination.db
              .prepare('DELETE FROM observations WHERE station_id=? AND observed_at<? AND rowid!=?')
              .run(s.value.id, threshold, last.rowid);
        }
        watermark = recent.length ? Math.max(watermark, ...recent.map((r) => r.received_at)) : source.clock();
        destination.db
          .prepare(
            "INSERT INTO meta VALUES ('projection_watermark',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(String(watermark));
      })
      .immediate();
    invalidateWeatherCache(destination);
    for (const s of destination.stationList().filter((s) => s.value.enabled))
      exportStation(destination, s.value);
  }
  return { sync, close: () => destination.close(), store: destination };
}
