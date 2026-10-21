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
      : mode === 'davis-iss-rs485'
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
          <option value="davis-iss-rs485">Kablet ISS – MAX3485, uten konsoll</option>
        </select>
      </label>
      {mode === 'davis-iss-rs485' && (
        <p className="notice">
          Direkte kablet Vantage Pro2 ISS: 4800 baud, 8N1. Bruk MAX3485 med 3,3 V-logikk og separat 5 V
          ISS-strømforsyning. ESP32 lytter; den sender ingen kommandoer på ISS-bussen.
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
              disabled={mode === 'davis-iss-rs485'}
              onChange={(e) => set('uartBaud', e.target.value)}
            >
              {(mode === 'davis-iss-rs485' ? ['4800'] : ['1200', '2400', '9600', '19200']).map((n) => (
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
        {mode === 'davis-iss-rfm69' && (
          <label>
            RSSI-trigger (dBm)
            <input
              type="number"
              required
              min="-120"
              max="-40"
              value={value.radioRssiThresholdDbm ?? -85}
              onChange={(e) => set('radioRssiThresholdDbm', Number(e.target.value))}
            />
            <small>Standard −85 dBm. Lavere tall slipper inn svakere signaler og mer støy.</small>
          </label>
        )}
      </div>
    </fieldset>
  );
}
