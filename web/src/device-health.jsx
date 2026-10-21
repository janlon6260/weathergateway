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
          <dt>Boot-ID</dt>
          <dd className="monospace small">{health.bootId || '–'}</dd>
        </dl>
      </details>
    </div>
  );
}
