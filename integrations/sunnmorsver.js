// Copy into the Sunnmørsvær backend and pass its existing io/data objects.
// No site files are changed automatically. Keep its forecasting/Netatmo services.
import { io as connect } from 'socket.io-client';

export function connectWeatherGateway({ io, data, url, readToken, stationKeys }) {
  if (!url?.startsWith('https://') || !readToken || readToken.length < 32) throw new Error('Gatewayen krever HTTPS og et separat lesetoken');
  const allowed = new Set(stationKeys);
  const socket = connect(url, { auth: { token: readToken }, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelayMax: 10000, timeout: 10000 });
  socket.on('file-content', update => {
    if (!update || typeof update !== 'object' || Array.isArray(update)) return;
    const accepted = {};
    for (const [station, value] of Object.entries(update)) {
      if (!allowed.has(station) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const incoming = Date.parse(value.lastValidTime), existing = Date.parse(data[station]?.lastValidTime);
      if (Number.isFinite(existing) && (!Number.isFinite(incoming) || incoming < existing)) continue;
      // A source object cannot replace prototypes/internal application members.
      accepted[station] = Object.fromEntries(Object.entries(value).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)));
      data[station] = { ...data[station], ...accepted[station] };
    }
    if (Object.keys(accepted).length) io.emit('file-content', accepted);
  });
  socket.on('connect_error', error => console.error(JSON.stringify({ event: 'gateway_connection_failed', type: error.name })));
  return () => socket.disconnect();
}
