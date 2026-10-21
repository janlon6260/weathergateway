import React from 'react';
import {
  ageLabel,
  liveDataStatus,
  deviceConnectionStatus,
  freshnessThresholds,
} from '../../shared/freshness.js';
import { windPresentation } from '../../shared/wind.js';

const fields = {
  temperatureC: ['Temperatur', '°C'],
  humidityPct: ['Luftfuktighet', '%'],
  pressureHpa: ['Lufttrykk', 'hPa'],
  windSpeedMs: ['Vindhastighet', 'm/s'],
  windDirectionDeg: ['Vind fra', '°'],
  windMeanMs: ['Middelvind', 'm/s'],
  windGustMs: ['Vindkast', 'm/s'],
  rainTodayMm: ['Nedbør i dag', 'mm'],
  rainRateMmH: ['Regnrate', 'mm/t'],
  solarWm2: ['Solstråling', 'W/m²'],
  uvIndex: ['UV-indeks', ''],
  dewPointC: ['Duggpunkt', '°C'],
  windChillC: ['Vindavkjøling', '°C'],
  heatIndexC: ['Varmeindeks', '°C'],
  apparentTemperatureC: ['Følt temperatur', '°C'],
  humidexC: ['Humidex', ''],
};
const date = (at) => (at ? new Date(at).toLocaleString('nb-NO') : 'Ingen data');
export function StationDetails({ station, gateway, data = {}, now, onPackets }) {
  const limits = freshnessThresholds(gateway, station);
  const status = liveDataStatus(data, now, limits, station.enabled);
  const connection = deviceConnectionStatus(data.connection, now, station.enabled);
  const names = {
    green: 'Ferske data',
    orange: 'Forsinkede data',
    red: 'For gamle data',
    unknown: 'Ingen data',
    disabled: 'Deaktivert',
  };
  const packet = data.lastPacket;
  const wind = windPresentation(data.wlatest, data.bearing);
  return (
    <div className="station-details">
      <p className="eyebrow">MÅLEDETALJER</p>
      <h2 id="modal-title">{station.name}</h2>
      <div className="detail-summary">
        <div>
          <span>ESP-kontakt</span>
          <strong>
            {
              {
                online: 'Tilkoblet',
                offline: 'Frakoblet',
                unknown: 'Ingen kontakt registrert',
                disabled: 'Deaktivert',
              }[connection]
            }
          </strong>
          <small>
            {ageLabel(data.connection?.lastContactAt, now)} · tidsavbrudd{' '}
            {data.connection?.timeoutSeconds ?? 30} s
          </small>
        </div>
        <div>
          <span>Status</span>
          <strong>{names[status]}</strong>
        </div>
        <div>
          <span>Siste gyldige værdata</span>
          <strong>{ageLabel(data.lastValidTime, now)}</strong>
          <small>{date(data.lastValidTime)}</small>
        </div>
        <div>
          <span>Siste telemetri til gateway</span>
          <strong>{ageLabel(data.lastPacketReceivedAt, now)}</strong>
          <small>{date(data.lastPacketReceivedAt)}</small>
        </div>
        <div>
          <span>Terskler · {station.freshness ? 'egne for stasjonen' : 'globale'}</span>
          <strong>
            Oransje etter {limits.warningSeconds} s · rød etter {limits.downSeconds} s
          </strong>
        </div>
      </div>
      <p>
        Vindretning lagres som retningen vinden kommer <strong>fra</strong>. Pilen viser hvor vinden blåser{' '}
        <strong>mot</strong>.
      </p>
      {wind.fromDegrees !== null && (
        <p className="wind-detail">
          Fra {wind.fromCompass} ({wind.fromDegrees.toFixed(1)}°)
          {wind.toDegrees !== null && (
            <>
              {' '}
              → mot {wind.toCompass} ({wind.toDegrees.toFixed(1)}°)
            </>
          )}
          {wind.beaufort !== null && <> · Beaufort {wind.beaufort}</>}
        </p>
      )}
      <div className="table-scroll">
        <table className="measurement-details">
          <thead>
            <tr>
              <th>Måling</th>
              <th>Siste verdi</th>
              <th>Alder</th>
              <th>Måletid</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(fields).map(([metric, [label, unit]]) => {
              const field = data.fields?.[metric];
              return (
                <tr key={metric}>
                  <td>{label}</td>
                  <td>
                    {typeof field?.value === 'number'
                      ? `${field.value.toLocaleString('nb-NO', { maximumFractionDigits: 2 })} ${unit}`
                      : '–'}
                  </td>
                  <td>{ageLabel(field?.at, now)}</td>
                  <td>{date(field?.at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {packet && (
        <p className="small">
          Siste værpakke: {packet.protocol} · nr. {packet.sequence}
          {packet.channel !== null && <> · kanal {packet.channel}</>}
          {packet.rssiDbm !== null && <> · {packet.rssiDbm} dBm</>}
          {packet.rawWindDirectionByte !== undefined && <> · rå retningsbyte {packet.rawWindDirectionByte}</>}
        </p>
      )}
      <button className="secondary" onClick={onPackets}>
        Se råpakker siste minutt
      </button>
    </div>
  );
}
