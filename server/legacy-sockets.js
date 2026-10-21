import { DateTime } from 'luxon';
import { snapshot, history } from './observations.js';
import { Rejected } from './store.js';
import { rainCoverageComplete } from './davis-iss.js';

export const trendMetrics = {
  temperature: 'temperatureC',
  humidity: 'humidityPct',
  barometer: 'pressureHpa',
  rain: 'rainRateMmH',
  daily_rainfall: 'rainTodayMm',
  currwind: 'windMeanMs',
  gustwind: 'windGustMs',
};
const thresholds = {
  temperature: 0.2,
  humidity: 2,
  barometer: 0.1,
  rain: 0.2,
  daily_rainfall: 0.2,
  currwind: 0.5,
  gustwind: 0.5,
};
const caches = new WeakMap();
function stationFor(store, key) {
  const s = store
    .stationList()
    .find((s) => s.value.key === key && s.value.enabled && s.value.model !== 'Netatmo');
  if (!s) throw new Rejected('Ukjent stasjon', 404);
  return s.value;
}
export function trendFromPoints(points, type) {
  points = points.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.at));
  if (points.length < 2) return 'flat';
  let delta = points.at(-1).value - points[0].value;
  if (type === 'barometer') {
    if (points.length < 6 || points.at(-1).at - points[0].at < 2.75 * 3600000) return 'flat';
    const xs = points.map((p) => (p.at - points[0].at) / 3600000),
      mx = xs.reduce((s, x) => s + x, 0) / xs.length,
      my = points.reduce((s, p) => s + p.value, 0) / points.length;
    const variance = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    delta = variance ? (points.reduce((s, p, i) => s + (xs[i] - mx) * (p.value - my), 0) / variance) * 3 : 0;
  }
  return Math.abs(delta) + 1e-8 < thresholds[type] || Math.abs(delta) < 1e-8
    ? 'flat'
    : delta > 0
      ? 'up'
      : 'down';
}
export function trendSnapshot(store) {
  const cached = caches.get(store),
    now = store.clock();
  if (cached && now >= cached.at && now - cached.at < 30000) return cached.value;
  const result = {};
  for (const station of store.stationList().filter((s) => s.value.enabled && s.value.model !== 'Netatmo')) {
    const rows = store.db
      .prepare(
        "SELECT observed_at,body FROM observations WHERE station_id=? AND observed_at>=? AND observed_at<=? AND json_extract(body,'$.sensorContact')=1 ORDER BY observed_at",
      )
      .all(station.value.id, now - 3 * 3600000, now);
    const points = rows.map((r) => ({ at: r.observed_at, ...JSON.parse(r.body).measurements }));
    result[station.value.key] = Object.fromEntries(
      Object.entries(trendMetrics).map(([type, metric]) => [
        type,
        trendFromPoints(
          points
            .filter((p) => type === 'barometer' || p.at >= now - 3600000)
            .map((p) => ({ at: p.at, value: p[metric] })),
          type,
        ),
      ]),
    );
  }
  caches.set(store, { at: now, value: result });
  return result;
}
export function trendRows(store, key, type) {
  if (!Object.hasOwn(trendMetrics, type)) throw new Rejected('Ukjent målingstype', 400);
  const station = stationFor(store, key),
    now = store.clock();
  const rows = store.db
    .prepare(
      'SELECT period,total,samples,maximum FROM rollups WHERE station_id=? AND metric=? AND period>=? AND period<=? AND length(period)>10 ORDER BY period',
    )
    .all(
      station.id,
      trendMetrics[type],
      new Date(Math.floor((now - 86400000) / 3600000) * 3600000).toISOString(),
      new Date(now).toISOString(),
    );
  return rows.map((r) => ({
    timestamp: r.period,
    value: type === 'daily_rainfall' ? r.maximum : r.total / r.samples,
  }));
}
export function dayResponse(store, key, date) {
  const station = stationFor(store, key),
    report = history(store, station.id, date);
  const data = report.hourly.map((h) => ({
    timestamp: DateTime.fromISO(h.at).setZone('Europe/Oslo').toFormat('yyyy-MM-dd HH:mm:ss'),
    timestampUTC: h.at,
    samples: h.samples,
    temperature: h.temperatureC ?? null,
    min_temperature: h.temperatureC_MIN ?? null,
    max_temperature: h.temperatureC_MAX ?? null,
    outdoor_humidity: h.humidityPct ?? null,
    barometer: h.pressureHpa ?? null,
    rain_rate: h.rainRateMmH ?? null,
    daily_rainfall: h.rainTodayMm_MAX ?? null,
    average_windspeed: h.windMeanMs ?? null,
    max_average_windspeed: h.windMeanMs_MAX ?? null,
    gust_windspeed: h.windGustMs ?? null,
    max_gust_windspeed: h.windGustMs_MAX ?? null,
  }));
  const rainfall = store.db
    .prepare('SELECT * FROM rain_state WHERE station_id=? AND day=?')
    .get(station.id, date);
  return {
    station: key,
    data,
    maxGust: report.summary.windGustMs_MAX ?? null,
    dailyRainfall: rainCoverageComplete(rainfall, station.rainCounterMmPerUnit, store.clock())
      ? rainfall.total_mm
      : null,
    maxAverageWindspeed: report.summary.windMeanMs_MAX ?? null,
    maxRainRate: report.summary.rainRateMmH_MAX ?? null,
  };
}
export function attachLegacySockets(
  io,
  store,
  {
    authorize = () => null,
    filter = (_socket, object) => object,
    station = (_socket, key) => key,
    snapshot: current = () => snapshot(store),
  } = {},
) {
  io.on('connection', (socket) => {
    socket.emit('file-content', filter(socket, current()));
    socket.emit('trend_snapshot', filter(socket, trendSnapshot(store)));
    let window = store.clock(),
      requests = 0;
    const handle = (event, fn) =>
      socket.on(event, (payload) => {
        if (store.clock() - window >= 60000 || store.clock() < window) {
          window = store.clock();
          requests = 0;
        }
        if (++requests > 60) {
          socket.emit('trendData', { error: 'Rate limit' });
          return;
        }
        try {
          authorize(socket);
          fn(payload);
        } catch {
          socket.emit('trendData', { error: 'Invalid request or data unavailable' });
        }
      });
    handle('get_trends', () => socket.emit('trend_snapshot', filter(socket, trendSnapshot(store))));
    handle('fetch24HourTrend', (p) => {
      if (!p || typeof p.station !== 'string' || typeof p.type !== 'string') throw new Error();
      socket.emit('trendData', {
        station: station(socket, p.station),
        type: p.type,
        data: trendRows(store, station(socket, p.station), p.type),
      });
    });
    handle('fetchTrendData', (p) => {
      if (!p || typeof p.station !== 'string' || typeof p.date !== 'string') throw new Error();
      socket.emit('trendData', dayResponse(store, station(socket, p.station), p.date));
    });
  });
  let previous = {};
  const timer = setInterval(() => {
    if (!io.engine.clientsCount) return;
    const next = trendSnapshot(store);
    for (const [station, types] of Object.entries(next))
      for (const [type, trend] of Object.entries(types))
        if (previous[station]?.[type] !== trend)
          for (const socket of io.of('/').sockets.values())
            try {
              if (Object.hasOwn(filter(socket, { [station]: true }), station))
                socket.emit('trend_update', { station, type, trend });
            } catch {
              socket.disconnect(true);
            }
    previous = next;
  }, 30000);
  timer.unref();
  return () => clearInterval(timer);
}
