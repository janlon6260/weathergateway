import React from 'react';
import { deviceProfile } from '../../shared/device-hardware.js';
export function DeviceHardware({ value, onChange }) {
  const mode = value.interface || 'weatherlink-serial',
    set = (key, v) => onChange({ ...value, [key]: v });
  const pins =
    mode === 'davis-iss-rfm69'
      ? [
          ['spiSck', 'SPI SCK'],
          ['spiMiso', 'SPI MISO'],
          ['spiMosi', 'SPI MOSI'],
          ['radioCs', 'Radio CS'],
          ['radioReset', 'Radio RST'],
          ['radioDio0', 'Radio DIO0'],
        ]
      : mode === 'davis-iss-rs485-capture'
        ? [
            ['uartRx', 'MAX3485 RO → ESP32 RX'],
            ['rs485De', 'MAX3485 DE (holdes lav)'],
            ['rs485Re', 'MAX3485 /RE (holdes lav)'],
          ]
        : [
            ['uartRx', 'ESP32 RX'],
            ['uartTx', 'ESP32 TX'],
          ];
  return (
    <fieldset className="settings-section">
      <legend>Stasjonsgrensesnitt før kompilering</legend>
      <label>
        Maskinvare og datakilde
        <select
          aria-label="Maskinvare og datakilde"
          value={mode}
          onChange={(e) => onChange(deviceProfile(value, e.target.value))}
        >
          <option value="davis-iss-rfm69">Trådløs ISS – RFM69HCW EU868</option>
          <option value="weatherlink-serial">WeatherLink seriell – Davis-konsoll</option>
          <option value="davis-iss-rs485-capture">Kablet ISS – MAX3485, opptak og diagnostikk</option>
        </select>
      </label>
      {mode === 'davis-iss-rs485-capture' && (
        <p className="notice">
          Direkte ISS-protokoll er ikke verifisert ennå. Denne profilen logger rådata og sender ingen
          kommandoer på ISS-bussen. Den produserer ikke værmålinger. Bruk MAX3485 med 3,3 V-logikk og separat,
          korrekt ISS-strømforsyning. RS-485-opptak installeres via USB.
        </p>
      )}
      <div className="form-grid">
        {mode === 'davis-iss-rfm69' ? (
          <label>
            ISS sender-ID
            <input
              type="number"
              required
              min="1"
              max="8"
              value={value.transmitterId}
              onChange={(e) => set('transmitterId', Number(e.target.value))}
            />
          </label>
        ) : (
          <label>
            UART-hastighet
            <select
              aria-label="UART-hastighet"
              value={value.uartBaud}
              onChange={(e) => set('uartBaud', e.target.value)}
            >
              {(mode === 'davis-iss-rs485-capture'
                ? ['1200', '2400', '4800', '9600', '19200', '38400']
                : ['1200', '2400', '9600', '19200']
              ).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
        )}
        {pins.map(([key, label]) => (
          <label key={key}>
            {label} GPIO
            <input
              type="number"
              required
              min="0"
              max="33"
              value={value[key]}
              onChange={(e) => set(key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
