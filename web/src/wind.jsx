import React from 'react';
import { windPresentation } from '../../shared/wind.js';
export function WindReading({ data = {}, now }) {
  const speed = data.fields?.windSpeedMs?.value ?? data.wlatest,
    from = data.fields?.windDirectionDeg?.value ?? data.bearing;
  const wind = windPresentation(
    typeof speed === 'number' ? speed : null,
    typeof from === 'number' ? from : null,
  );
  const label =
    wind.beaufort === 0
      ? 'Stille'
      : wind.toDegrees === null
        ? 'Vindretning mangler'
        : `Vind fra ${wind.fromCompass} (${Math.round(wind.fromDegrees)}°), mot ${wind.toCompass} (${Math.round(wind.toDegrees)}°)`;
  return (
    <div className="wind-reading">
      <span>
        {wind.speedMs === null
          ? '–'
          : `${wind.speedMs.toLocaleString('nb-NO', { maximumFractionDigits: 1 })} m/s`}
      </span>
      <span className="wind-direction" title={label} aria-label={label}>
        {wind.toDegrees === null ? (
          <span aria-hidden="true">{wind.beaufort === 0 ? '○' : '–'}</span>
        ) : (
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M12 2L6 9H10V22H14V9H18Z" transform={`rotate(${wind.toDegrees} 12 12)`} />
          </svg>
        )}
        <strong>{wind.beaufort ?? '–'}</strong>
        <small>Bft</small>
      </span>
    </div>
  );
}
