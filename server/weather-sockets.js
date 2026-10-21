import { Server } from 'socket.io';
import { z } from 'zod';
import { snapshot, latest, history } from './observations.js';
import { attachLegacySockets } from './legacy-sockets.js';
import { PublicAccess } from './api-clients.js';
import { hash } from './store.js';
import { windPresentation } from '../shared/wind.js';
const selection = z.object({ stations: z.array(z.string().min(1).max(100)).max(100).default([]) }).strict();
export function legacySocketSnapshot(store) {
  return Object.fromEntries(
    Object.entries(snapshot(store)).map(([name, value]) => {
      const numeric = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
      return [name, { ...value, wind: windPresentation(numeric(value.wlatest), numeric(value.bearing)) }];
    }),
  );
}
export function weatherSnapshot(store, access, client, selectors = []) {
  const selected = access.select(client, selectors),
    legacy = snapshot(store);
  return {
    schema: 'wg-weather-1',
    environment: store.environment,
    generatedAt: new Date(store.clock()).toISOString(),
    stations: selected.map((s) => {
      const body = latest(store, s.id);
      return {
        id: s.id,
        key: s.key,
        name: s.name,
        observedAt: body?.observedAt ?? null,
        receivedAt: body?.receivedAt ?? null,
        sensorContact: body?.sensorContact ?? false,
        measurements: body?.measurements ?? {},
        measurementTimes: body?.measurementTimes ?? {},
        derived: body?.derived ?? {},
        quality: body?.quality ?? null,
        weather: legacy[s.key] ?? null,
        wind: windPresentation(
          body?.sensorContact ? body.measurements?.windSpeedMs : null,
          body?.sensorContact ? body.measurements?.windDirectionDeg : null,
        ),
      };
    }),
  };
}
export function attachWeatherSockets(server, store, config) {
  const access = new PublicAccess(store, config),
    buckets = new Map();
  let io;
  const originAllowed = (origin) =>
    !origin || access.policy()?.clients.some((c) => c.origins.includes(origin));
  io = new Server(server, {
    serveClient: false,
    maxHttpBufferSize: 8192,
    perMessageDeflate: false,
    connectTimeout: 5000,
    cors: {
      origin: (origin, callback) => callback(null, !!originAllowed(origin)),
      methods: ['GET', 'POST'],
      credentials: false,
    },
    allowRequest: (req, callback) => {
      const now = Date.now(),
        ip = req.socket.remoteAddress || 'unknown';
      let b = buckets.get(ip);
      if (!b) {
        if (buckets.size >= 2048) {
          for (const [key, value] of buckets) if (now - value.at > 60000) buckets.delete(key);
          if (buckets.size >= 2048) return callback(null, false);
        }
        b = { at: now, count: 0 };
        buckets.set(ip, b);
      }
      if (now - b.at >= 60000) {
        b.at = now;
        b.count = 0;
      }
      callback(null, originAllowed(req.headers.origin) && ++b.count <= 60 && io.engine.clientsCount < 100);
    },
  });
  const namespaces = [io.of('/'), io.of('/weather')];
  const context = (socket) => {
    const client = access.authorize(socket.handshake.auth?.token, socket.handshake.headers.origin);
    if (!client) {
      if (socket.connected) socket.disconnect(true);
      throw new Error('Lesetilgang er ikke godkjent eller er utløpt');
    }
    if (socket.data.clientId && socket.data.clientId !== client.id) {
      if (socket.connected) socket.disconnect(true);
      throw new Error('Tilgangen er endret');
    }
    return client;
  };
  for (const ns of namespaces)
    ns.use((socket, next) => {
      try {
        const client = context(socket);
        let count = 0;
        for (const scope of namespaces)
          for (const other of scope.sockets.values()) if (other.data.clientId === client.id) count++;
        if (count >= client.maxConnections) return next(new Error('For mange tilkoblinger'));
        socket.data.clientId = client.id;
        socket.data.selectors = selection.parse({ stations: socket.handshake.auth?.stations || [] }).stations;
        access.select(client, socket.data.selectors);
        next();
      } catch {
        next(new Error('Lesetilgang er ikke godkjent eller stasjonsvalget er ugyldig'));
      }
    });
  const stopLegacy = attachLegacySockets(io, store, {
    authorize: context,
    filter: (socket, object) => access.filter(context(socket), object, socket.data.selectors),
    station: (socket, selector) => access.select(context(socket), [selector])[0].key,
    snapshot: () => legacySocketSnapshot(store),
  });
  const weather = io.of('/weather');
  weather.on('connection', (socket) => {
    let window = Date.now(),
      requests = 0;
    const emit = () => {
      const value = weatherSnapshot(store, access, context(socket), socket.data.selectors);
      socket.data.signature = hash(value.stations);
      socket.emit('weather:snapshot', value);
      return value;
    };
    emit();
    const handle = (event, fn) =>
      socket.on(event, (input, ack) => {
        if (typeof ack !== 'function') return;
        try {
          context(socket);
          if (Date.now() - window >= 60000) {
            window = Date.now();
            requests = 0;
          }
          if (++requests > 60) throw new Error('For mange forespørsler');
          ack({ ok: true, data: fn(input ?? {}) });
        } catch {
          ack({ ok: false, error: 'Forespørselen er ugyldig eller ikke godkjent' });
        }
      });
    handle('weather:subscribe', (input) => {
      const { stations } = selection.parse(input);
      access.select(context(socket), stations);
      socket.data.selectors = stations;
      return emit();
    });
    handle('weather:get', (input) => {
      const { stations } = selection.parse(input);
      return weatherSnapshot(store, access, context(socket), stations);
    });
    handle('weather:history', (input) => {
      const p = z
          .object({ station: z.string().min(1).max(100), date: z.iso.date() })
          .strict()
          .parse(input),
        station = access.select(context(socket), [p.station])[0];
      return {
        schema: 'wg-weather-history-1',
        station: { id: station.id, key: station.key, name: station.name },
        ...history(store, station.id, p.date),
      };
    });
  });
  const timer = setInterval(() => {
    const active = new Map();
    for (const ns of namespaces)
      for (const socket of ns.sockets.values())
        try {
          const client = context(socket);
          const count = (active.get(client.id) || 0) + 1;
          active.set(client.id, count);
          if (count > client.maxConnections) {
            socket.disconnect(true);
            continue;
          }
          if (ns === weather) {
            const value = weatherSnapshot(store, access, client, socket.data.selectors),
              signature = hash(value.stations);
            if (signature !== socket.data.signature) {
              socket.data.signature = signature;
              socket.emit('weather:snapshot', value);
            }
          } else {
            const value = access.filter(client, legacySocketSnapshot(store), socket.data.selectors),
              signature = hash(value);
            if (signature !== socket.data.signature) {
              socket.data.signature = signature;
              socket.emit('file-content', value);
            }
          }
        } catch {
          socket.disconnect(true);
        }
  }, 1000);
  timer.unref();
  return () => {
    clearInterval(timer);
    stopLegacy();
    io.close();
  };
}
