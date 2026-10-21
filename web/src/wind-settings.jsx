import React, { useState } from 'react';
import {
  windDirectionDefaults,
  windDirectionProfiles,
  decodeWindDirection,
  normalizeDirection,
} from '../../shared/wind-direction.js';
export function WindSettings({ item, set, lastPacket }) {
  const [raw, setRaw] = useState(lastPacket?.rawWindDirectionByte ?? 128);
  const settings = { ...windDirectionDefaults, ...item.windDirection };
  const change = (key, value) => set({ ...item, windDirection: { ...settings, [key]: value } });
  const decoded = decodeWindDirection(raw, item.model, settings);
  const from =
    decoded === null ? null : normalizeDirection(decoded + item.calibration.windDirectionOffsetDeg);
  return (
    <fieldset className="settings-section wind-settings">
      <legend>Vindretning fra ISS</legend>
      <div className="form-grid">
        <label>
          Dekodingsprofil
          <select value={settings.decoder} onChange={(e) => change('decoder', e.target.value)}>
            {Object.entries(windDirectionProfiles).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Råbyte 0 betyr
          <select value={settings.zero} onChange={(e) => change('zero', e.target.value)}>
            <option value="north">Nord (0°)</option>
            <option value="missing">Manglende retning</option>
            <option value="decode">Bruk profilens formel</option>
          </select>
        </label>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.reverse}
          onChange={(e) => change('reverse', e.target.checked)}
        />
        Speil rotasjonsretningen før retningskorreksjon
      </label>
      {settings.decoder === 'custom' && (
        <div className="form-grid">
          {[
            ['rawStart', 'Råverdi start', 0, 255],
            ['rawEnd', 'Råverdi slutt', 0, 255],
            ['degreesStart', 'Vinkel start (grader)', -360, 720],
            ['degreesEnd', 'Vinkel slutt (grader)', -360, 720],
          ].map(([key, label, min, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={min}
                max={max}
                step={key.startsWith('raw') ? '1' : 'any'}
                required
                value={settings[key]}
                onChange={(e) => change(key, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
      )}
      <div className="actions direction-shortcuts">
        <span>Juster monteringsretning:</span>
        {[-90, 90, 180].map((offset) => (
          <button
            type="button"
            className="secondary"
            key={offset}
            onClick={() =>
              set({
                ...item,
                calibration: {
                  ...item.calibration,
                  windDirectionOffsetDeg:
                    normalizeDirection(item.calibration.windDirectionOffsetDeg + offset + 180) - 180,
                },
              })
            }
          >
            {offset > 0 ? '+' : ''}
            {offset}°
          </button>
        ))}
      </div>
      <label>
        Rå retningsbyte for forhåndsvisning (0–255)
        <input
          type="number"
          min="0"
          max="255"
          step="1"
          value={raw}
          onChange={(e) => setRaw(Number(e.target.value))}
        />
      </label>
      {lastPacket?.rawWindDirectionByte !== undefined && (
        <button type="button" className="text-button" onClick={() => setRaw(lastPacket.rawWindDirectionByte)}>
          Bruk siste mottatte råbyte ({lastPacket.rawWindDirectionByte})
        </button>
      )}
      <output className="direction-preview">
        {from === null
          ? 'Manglende retning'
          : `Dekodet ${decoded.toFixed(1)}° → kalibrert fra ${from.toFixed(1)}° → pil mot ${normalizeDirection(from + 180).toFixed(1)}°`}
      </output>
      <p className="muted small">
        Automatisk følger valgt stasjonsmodell. Kontroller mot kjent vindretning før du bytter profil.
        Retningskorreksjon i Kalibrering legges til etter dekoding. Valgene gjelder nye ISS-målinger etter
        «Gjør gjeldende» og krever ingen ny flashing.
      </p>
    </fieldset>
  );
}
