// Beaufort thresholds in m/s; a wind bearing is where the wind comes FROM.
export function beaufort(speedMs) {
  if (typeof speedMs !== 'number' || !Number.isFinite(speedMs) || speedMs < 0) return null;
  return [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7].filter((limit) => speedMs >= limit)
    .length;
}
export const compassPoints = ['N', 'NØ', 'Ø', 'SØ', 'S', 'SV', 'V', 'NV'];
export function windPresentation(speedMs, fromDegrees, arrowDirection = 'from') {
  const force = beaufort(speedMs);
  const from =
    typeof fromDegrees === 'number' && Number.isFinite(fromDegrees) && fromDegrees >= 0 && fromDegrees <= 360
      ? fromDegrees % 360
      : null;
  const to = from !== null && force !== null && force !== 0 ? (from + 180) % 360 : null;
  return {
    speedMs: force === null ? null : speedMs,
    fromDegrees: from,
    toDegrees: to,
    arrowRotationDegrees: to === null ? null : arrowDirection === 'to' ? to : from,
    arrowDirection: arrowDirection === 'to' ? 'to' : 'from',
    fromCompass: from === null ? null : compassPoints[Math.round(from / 45) % 8],
    toCompass: to === null ? null : compassPoints[Math.round(to / 45) % 8],
    beaufort: force,
    beaufortBasis: 'windSpeedMs',
  };
}
