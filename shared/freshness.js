export function freshnessThresholds(gateway, station) {
  return (
    station?.freshness || {
      warningSeconds: gateway.dataWarningSeconds ?? 3,
      downSeconds: gateway.dataDownSeconds ?? 30,
    }
  );
}
export function dataStatus(at, now, thresholds, enabled = true) {
  if (!enabled) return 'disabled';
  if (!at) return 'unknown';
  const age = Math.max(0, (now - Date.parse(at)) / 1000);
  return age > thresholds.downSeconds ? 'red' : age > thresholds.warningSeconds ? 'orange' : 'green';
}
// Use one complete server snapshot between updates. A local clock tick must not
// age an old sample just before the next SSE frame supplies its replacement.
// If the stream stops, local aging resumes after two expected 1-second frames.
export const liveSnapshotIntervalMs = 1000;
export function liveDataStatus(data = {}, now, thresholds, enabled = true) {
  if (!enabled) return 'disabled';
  const snapshotAge = now - data.asOf;
  if (
    Number.isFinite(snapshotAge) &&
    Math.abs(snapshotAge) <= liveSnapshotIntervalMs * 2 &&
    ['green', 'orange', 'red', 'unknown'].includes(data.status)
  )
    return data.status;
  return dataStatus(data.lastValidTime, now, thresholds, enabled);
}
export function deviceConnectionStatus(connection, now, enabled = true) {
  if (!enabled) return 'disabled';
  if (!connection) return 'unknown';
  if (connection.state !== 'online') return connection.state;
  const lastContact = Date.parse(connection.lastContactAt);
  if (!Number.isFinite(lastContact)) return 'unknown';
  return now - lastContact > connection.timeoutSeconds * 1000 ? 'offline' : 'online';
}
export function ageLabel(at, now) {
  if (!at) return 'Ingen data ennå';
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 60) return `${seconds} s siden`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s siden`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)} t ${Math.floor((seconds % 3600) / 60)} min siden`;
  return `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} t siden`;
}
