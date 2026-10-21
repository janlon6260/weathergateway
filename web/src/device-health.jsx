import React from 'react';
import { ageLabel } from '../../shared/freshness.js';
const bytes = (n) => (typeof n === 'number' ? `${(n / 1024).toFixed(1)} kB` : '–');
export function DeviceHealth({ health, now }) {
  if (!health) return <p className="muted small">Venter på helsestatus fra ESP32.</p>;
  return (
    <div className="device-health">
      <p className="muted small">
        {health.online ? 'Siste status: MQTT tilkoblet' : 'MQTT frakoblet'} · heartbeat{' '}
        {ageLabel(new Date(health.lastContactAt || health.receivedAt).toISOString(), now)}
        {health.firmwareVersion && ` · FW ${health.firmwareVersion}`}
      </p>
      <div className="health-grid">
        <div>
          <span>Oppetid</span>
          <strong>
            {typeof health.uptimeMs === 'number'
              ? `${Math.floor(health.uptimeMs / 3600000)} t ${Math.floor((health.uptimeMs % 3600000) / 60000)} min`
              : '–'}
          </strong>
        </div>
        <div>
          <span>Ledig minne</span>
          <strong>{bytes(health.freeHeapBytes)}</strong>
        </div>
        <div>
          <span>Laveste ledige minne</span>
          <strong>{bytes(health.minimumFreeHeapBytes)}</strong>
        </div>
        <div>
          <span>Wi-Fi-signal</span>
          <strong>{health.wifiRssiDbm === undefined ? '–' : `${health.wifiRssiDbm} dBm`}</strong>
        </div>
        {health.radio && (
          <div>
            <span>ISS-radio</span>
            <strong>
              {
                { tracking: 'Følger sender', scanning: 'Søker etter sender', unavailable: 'Radiofeil' }[
                  health.radio.state
                ]
              }
              {health.radio.rssiDbm !== undefined && ` · ${health.radio.rssiDbm} dBm`}
            </strong>
          </div>
        )}
      </div>
      <details>
        <summary>Mer om ESP-helse</summary>
        <dl>
          <dt>Siste omstartsårsak</dt>
          <dd>{health.resetReason || 'Ikke rapportert'}</dd>
          <dt>Antall oppstarter</dt>
          <dd>{health.bootCount ?? '–'}</dd>
          <dt>Wi-Fi / MQTT gjenoppkoblinger</dt>
          <dd>
            {health.wifiReconnects ?? '–'} / {health.mqttReconnects ?? '–'}
          </dd>
          <dt>Største ledige minneblokk</dt>
          <dd>{bytes(health.largestFreeBlockBytes)}</dd>
          <dt>Ledig hovedstakk</dt>
          <dd>{bytes(health.mainTaskStackFreeBytes)}</dd>
          <dt>ISS-pakker mottatt</dt>
          <dd>{health.packetsReceived ?? '–'}</dd>
          <dt>Siste ISS-pakke</dt>
          <dd>
            {health.lastIssPacketAgeMs === undefined
              ? '–'
              : `${(health.lastIssPacketAgeMs / 1000).toFixed(1)} s siden ved siste heartbeat`}
          </dd>
          <dt>Sendekø / kapasitet / tapte</dt>
          <dd>
            {health.pending ?? '–'} / {health.capacity ?? '–'} / {health.dropped ?? '–'}
          </dd>
          <dt>CPU / flash</dt>
          <dd>
            {health.cpuFrequencyMhz ?? '–'} MHz / {bytes(health.flashSizeBytes)}
          </dd>
          <dt>Klokke synkronisert</dt>
          <dd>{health.clockSynchronized ? 'Ja' : 'Nei / ikke rapportert'}</dd>
          <dt>ESP-IDF</dt>
          <dd>{health.idfVersion || '–'}</dd>
          {health.radio && (
            <>
              <dt>ISS-ID / lyttekanal</dt>
              <dd>
                {health.radio.transmitterId} / {health.radio.channel} av 5 (frekvenshopping)
              </dd>
              <dt>Radiopakker / uteblitte pakker</dt>
              <dd>
                {health.radio.packetsReceived ?? 0} / {health.radio.missedPackets ?? 0}
              </dd>
              <dt>Siste radioankomst</dt>
              <dd>
                {health.radio.lastPacketAgeMs === undefined
                  ? 'Venter på første pakke'
                  : `${(health.radio.lastPacketAgeMs / 1000).toFixed(1)} s før siste heartbeat`}
              </dd>
              <dt>CRC-feil / FIFO-overflyt / SPI-feil</dt>
              <dd>
                {health.radio.crcErrors ?? 0} / {health.radio.fifoOverruns ?? 0} /{' '}
                {health.radio.spiErrors ?? 0}
              </dd>
              <dt>Ny synkronisering / gamle FIFO-pakker</dt>
              <dd>
                {health.radio.resyncs ?? 0} / {health.radio.stalePackets ?? 0}
              </dd>
              <dt>Andre ISS-ID-er / repeaterpakker</dt>
              <dd>
                {health.radio.foreignPackets ?? 0} / {health.radio.repeaterPackets ?? 0}
              </dd>
              <dt>Radiokø / tapte i kø / lengste pollpause</dt>
              <dd>
                {health.radio.queuedPackets ?? 0} / {health.radio.queueDropped ?? 0} /{' '}
                {health.radio.maxPollGapMs ?? 0} ms
              </dd>
              <dt>RSSI-trigger / signal mellom pakker</dt>
              <dd>
                {health.radio.rssiThresholdDbm ?? '–'} / {health.radio.backgroundRssiDbm ?? '–'} dBm
              </dd>
              <dt>Signal uten pakke / PLL-feil</dt>
              <dd>
                {health.radio.signalTimeouts ?? '–'} / {health.radio.pllTimeouts ?? '–'}
              </dd>
              <dt>Frekvenskorreksjon (AFC)</dt>
              <dd>{health.radio.afcHz === undefined ? '–' : `${health.radio.afcHz} Hz`}</dd>
              {health.radio.lastRejected && (
                <>
                  <dt>Siste avviste radiopakke</dt>
                  <dd className="monospace small">
                    {health.radio.lastRejected.reason || '–'}: {health.radio.lastRejected.packetHex}
                  </dd>
                  <dt>Avvist: kanal / RSSI / AFC</dt>
                  <dd>
                    {health.radio.lastRejected.channel} / {health.radio.lastRejected.rssiDbm} dBm /{' '}
                    {health.radio.lastRejected.afcHz} Hz
                  </dd>
                </>
              )}
            </>
          )}
          <dt>Tapte innkommende MQTT-meldinger</dt>
          <dd>{health.mqttInputDropped ?? '–'}</dd>
          {health.rs485 && (
            <>
              <dt>RS-485-profil</dt>
              <dd>Kablet ISS · {health.rs485.baud} baud · uten kontrollsum på bussen</dd>
              <dt>Mottatte RS-485-byte</dt>
              <dd>{health.rs485.bytesReceived ?? 0}</dd>
              <dt>Gyldige / avviste rammer</dt>
              <dd>
                {health.rs485.framesReceived ?? 0} / {health.rs485.invalidFrames ?? 0}
              </dd>
              <dt>UART-feil / overflyt</dt>
              <dd>
                {health.rs485.uartErrors ?? 0} / {health.rs485.overflows ?? 0}
              </dd>
            </>
          )}
          <dt>Boot-ID</dt>
          <dd className="monospace small">{health.bootId || '–'}</dd>
        </dl>
      </details>
    </div>
  );
}
