import React, { useEffect, useState } from 'react';
import { packetKind, packetReadings, readingValue } from '../../shared/packet-values.js';
const number = (v) => (typeof v === 'number' ? v.toLocaleString('nb-NO', { maximumFractionDigits: 2 }) : '–');
export function RawPackets({ stations, api, initialStation = '' }) {
  const [stationId, setStation] = useState(initialStation);
  const [result, setResult] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true,
      timer;
    setResult(null);
    const refresh = async () => {
      try {
        const response = await api(
          `/packets${stationId ? `?stationId=${encodeURIComponent(stationId)}` : ''}`,
        );
        if (active) {
          setResult(response);
          setError('');
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) timer = setTimeout(refresh, 2000);
      }
    };
    refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [stationId]);
  return (
    <section className="panel raw-packets">
      <div className="panel-heading">
        <div>
          <h2>Råpakker · siste minutt</h2>
          <p className="muted small">
            Oppdateres hvert andre sekund. Vinduet følger når gatewayen mottok pakken.
          </p>
        </div>
        <label>
          Stasjon
          <select
            aria-label="Filtrer råpakker på stasjon"
            value={stationId}
            onChange={(e) => setStation(e.target.value)}
          >
            <option value="">Alle stasjoner</option>
            {stations.map((s) => (
              <option key={s.value.id} value={s.value.id}>
                {s.value.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="packet-help">
        Viser Davis-pakker videresendt av ESP32 via MQTT, inkludert pakker gatewayen har avvist. Radiopakker
        forkastet på ESP32 vises i enhetens radiodiagnostikk.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result?.truncated && (
        <p className="packet-help">
          Viser de {result.limit} nyeste pakkene. Velg én stasjon for et smalere utvalg.
        </p>
      )}
      {!result ? (
        <p className="empty">Henter pakker …</p>
      ) : !result.packets.length ? (
        <p className="empty">Ingen råpakker mottatt siste minutt.</p>
      ) : (
        <div className="packet-list">
          {result.packets.map((packet) => {
            const readings = packetReadings(packet);
            return (
              <details className="packet" key={packet.id}>
                <summary>
                  <span className="packet-meta">
                    <span>{new Date(packet.receivedAt).toLocaleTimeString('nb-NO')}</span>
                    <strong>{packet.stationName}</strong>
                    <span>{packetKind(packet)}</span>
                    <span>
                      {packet.status === 'accepted' ? 'Godkjent' : 'Avvist'} · #{packet.sequence}
                    </span>
                    <span>
                      {packet.channel !== null ? `Kanal ${packet.channel} · ` : ''}
                      {packet.rssiDbm !== null ? `${packet.rssiDbm} dBm` : ''}
                    </span>
                  </span>
                  <span className="packet-readable">
                    {packet.status !== 'accepted' ? (
                      <span className="packet-rejected">Pakken er avvist. WG bruker ikke måleverdiene.</span>
                    ) : (
                      <>
                        {readings
                          .filter((reading) => reading.source === 'packet')
                          .map((reading) => (
                            <span key={reading.metric}>
                              <span>{reading.label}</span>
                              <strong>{readingValue(reading)}</strong>
                            </span>
                          ))}
                        {packet.wind.beaufort !== null && (
                          <span>
                            <span>Beaufort</span>
                            <strong>{packet.wind.beaufort}</strong>
                          </span>
                        )}
                        {packet.wind.toDegrees !== null && (
                          <span>
                            <span>Blåser mot</span>
                            <strong>
                              {readingValue({ metric: 'windDirectionDeg' }, packet.wind.toDegrees)}
                            </strong>
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </summary>
                <div className="packet-content">
                  {packet.status === 'accepted' && (
                    <>
                      <h3>WG sin tolkning</h3>
                      <div className="table-scroll">
                        <table className="packet-measurements">
                          <thead>
                            <tr>
                              <th>Måling</th>
                              <th>WG tolker</th>
                              <th>Før kalibrering</th>
                              <th>Grunnlag</th>
                            </tr>
                          </thead>
                          <tbody>
                            {readings.map((reading) => (
                              <tr key={reading.metric}>
                                <td>{reading.label}</td>
                                <td>{readingValue(reading)}</td>
                                <td>
                                  {reading.rawValue === null ? '–' : readingValue(reading, reading.rawValue)}
                                </td>
                                <td>
                                  {
                                    {
                                      packet: 'Denne pakken',
                                      retained: 'Tidligere måling',
                                      calculated: 'Beregnet av WG',
                                    }[reading.source]
                                  }
                                  {reading.source === 'retained' && reading.at && (
                                    <small>{new Date(reading.at).toLocaleTimeString('nb-NO')}</small>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                  <details className="packet-technical">
                    <summary>Tekniske detaljer (råbytes og JSON)</summary>
                    <dl>
                      <dt>Mottatt</dt>
                      <dd>{new Date(packet.receivedAt).toLocaleString('nb-NO')}</dd>
                      <dt>Måletid</dt>
                      <dd>{packet.observedAt ? new Date(packet.observedAt).toLocaleString('nb-NO') : '–'}</dd>
                      <dt>Integritet</dt>
                      <dd>
                        {packet.checksum === 'none'
                          ? 'RS485 uten kontrollsum'
                          : packet.checksum === 'valid'
                            ? 'CRC OK'
                            : 'CRC ugyldig'}
                      </dd>
                      {packet.type !== undefined && (
                        <>
                          <dt>Pakketype / ISS-ID</dt>
                          <dd>
                            0x{packet.type.toString(16).toUpperCase()} / {packet.transmitterId} ·{' '}
                            {packet.batteryLow ? 'lavt batteri' : 'ingen batterivarsel'}
                          </dd>
                        </>
                      )}
                      {packet.reason && (
                        <>
                          <dt>Avvisningsårsak</dt>
                          <dd>{packet.reason}</dd>
                        </>
                      )}
                      <dt>Kalibreringsrevisjon</dt>
                      <dd>{packet.calibrationRevision ?? '–'}</dd>
                    </dl>
                    {packet.rawWindDirectionByte !== undefined && (
                      <div className="wind-packet-values">
                        <strong>Vindretning</strong>
                        Råbyte {packet.rawWindDirectionByte} → dekodet{' '}
                        {number(packet.rawMeasurements.windDirectionDeg)}° → kalibrert fra{' '}
                        {number(packet.measurements.windDirectionDeg)}° → pil mot{' '}
                        {number(packet.wind.toDegrees)}°
                      </div>
                    )}
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Byte (fra 0)</th>
                            {packet.bytes.map((_, i) => (
                              <th key={i}>{i}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <th>Hex</th>
                            {packet.bytes.map((v, i) => (
                              <td key={i}>{v.toString(16).padStart(2, '0').toUpperCase()}</td>
                            ))}
                          </tr>
                          <tr>
                            <th>Desimal</th>
                            {packet.bytes.map((v, i) => (
                              <td key={i}>{v}</td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <details>
                      <summary>Dekodede målinger og beregninger (JSON)</summary>
                      <pre>
                        {JSON.stringify(
                          {
                            rawMeasurements: packet.rawMeasurements,
                            measurements: packet.measurements,
                            derived: packet.derived,
                            wind: packet.wind,
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </details>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
