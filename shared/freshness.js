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
export function ageLabel(at, now) {
  if (!at) return 'Ingen data ennå';
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 60) return `${seconds} s siden`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s siden`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)} t ${Math.floor((seconds % 3600) / 60)} min siden`;
  return `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} t siden`;
}
