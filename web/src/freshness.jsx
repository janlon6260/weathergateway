import React from 'react';
import { liveDataStatus, freshnessThresholds } from '../../shared/freshness.js';
export function DataFreshness({ station, gateway, data = {}, now, onDetails }) {
  const thresholds = freshnessThresholds(gateway, station),
    status = liveDataStatus(data, now, thresholds, station.enabled);
  const labels = {
    green: 'Ferske data',
    orange: 'Forsinkede data',
    red: 'For gamle data',
    disabled: 'Deaktivert',
    unknown: 'Ingen data',
  };
  const Tag = onDetails ? 'button' : 'span';
  return (
    <Tag
      className={`status status-dot ${status}`}
      onClick={onDetails}
      {...(onDetails ? { type: 'button' } : { role: 'img' })}
      title={`${labels[status]}${onDetails ? ' – vis detaljer' : ''}`}
      aria-label={`${station.name}: ${labels[status]}${onDetails ? '. Vis måledetaljer' : ''}`}
    >
      <i aria-hidden="true" />
    </Tag>
  );
}
export function Measurement({ data, metric, alias, suffix, now }) {
  const field = data.fields?.[metric],
    at = field?.at || data.lastValidTime,
    value = field?.value ?? data[alias];
  return (
    <>
      <span title={at ? `Sist målt ${new Date(at).toLocaleString('nb-NO')}` : 'Ingen mottatt verdi'}>
        {value === null || value === undefined || value === ''
          ? '–'
          : `${typeof value === 'number' ? value.toLocaleString('nb-NO', { maximumFractionDigits: 1 }) : value}${suffix}`}
      </span>
    </>
  );
}
export function FreshnessFields({ item, set, gateway = false, globalSettings = {} }) {
  const inherited = !gateway && !item.freshness,
    warn = gateway ? 'dataWarningSeconds' : 'warningSeconds',
    down = gateway ? 'dataDownSeconds' : 'downSeconds',
    defaults = freshnessThresholds(globalSettings, {}),
    values = gateway ? item : item.freshness || defaults;
  const change = (key, value) =>
    set(gateway ? { ...item, [key]: value } : { ...item, freshness: { ...values, [key]: value } });
  return (
    <fieldset className="settings-section">
      <legend>Ferskhet på værdata</legend>
      {!gateway && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={inherited}
            onChange={(e) => set({ ...item, freshness: e.target.checked ? null : defaults })}
          />
          Følg globale terskelverdier
        </label>
      )}
      <div className="form-grid">
        <label>
          Oransje når data er eldre enn (sekunder)
          <input
            type="number"
            min="0.1"
            step="0.1"
            disabled={inherited}
            value={values[warn] ?? 3}
            onChange={(e) => change(warn, Number(e.target.value))}
          />
        </label>
        <label>
          Rød når data er eldre enn (sekunder)
          <input
            type="number"
            min="1"
            step="0.1"
            disabled={inherited}
            value={values[down] ?? 30}
            onChange={(e) => change(down, Number(e.target.value))}
          />
        </label>
      </div>
      <p className="muted small">
        Måleverdier slettes aldri fra visningen ved tidsavbrudd. Farge og alder viser hvor ferske de er.
      </p>
    </fieldset>
  );
}
