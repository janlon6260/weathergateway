import React, { useEffect, useRef, useState } from 'react';
import { DeviceHardware } from './device-hardware.jsx';

const states = {
  queued: 'Venter på byggeren',
  building: 'Kompilerer',
  ready: 'Ferdig og signert',
  failed: 'Mislyktes',
};
export function FirmwareBuilder({ stationId, api, busy = false, onUsbReady, onDeploy }) {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({
    mqttHost: '',
    mqttPort: 8883,
    ssid: '',
    wifiPassword: '',
    purpose: 'usb',
    years: 1,
  });
  const initialized = useRef(false),
    apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    setStatus(null);
    setError('');
    initialized.current = false;
    if (!stationId) return;
    let stopped = false,
      timer;
    const poll = async () => {
      try {
        const next = await apiRef.current(`/firmware-builds/stations/${stationId}`);
        if (stopped) return;
        setStatus(next);
        if (!initialized.current) {
          initialized.current = true;
          setForm({
            mqttHost: next.configuration.mqttHost,
            mqttPort: next.configuration.mqttPort,
            configuration: next.configuration,
            ssid: next.ssid,
            wifiPassword: '',
            purpose: 'usb',
            years: 1,
          });
        }
      } catch (e) {
        if (!stopped) setError(e.message);
      }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [stationId]);
  async function run(action) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((old) => ({ ...old, [key]: e.target.value })),
  });
  const building = status?.builds.some((b) => ['queued', 'building'].includes(b.state));
  return (
    <div className="usb-flash-box firmware-builder">
      <h3>Bygg firmware på serveren</h3>
      <p>
        Velg nettverksinnstillinger før kompilering. Serveren klargjør enhetssertifikatene, kompilerer og
        signerer firmwaren. Du trenger ingen lokale utviklingsverktøy.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {status && !status.available && (
        <p className="notice">Byggtjenesten er frakoblet. Start firmware-builder i Docker-stakken.</p>
      )}
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`/firmware-builds/stations/${stationId}`, {
              mqttHost: form.mqttHost,
              mqttPort: Number(form.mqttPort),
              ssid: form.ssid,
              ...(form.wifiPassword ? { wifiPassword: form.wifiPassword } : {}),
              purpose: form.purpose,
              validity: { amount: Number(form.years), unit: 'years' },
              configuration: form.configuration,
            });
            setForm((old) => ({ ...old, wifiPassword: '' }));
            setStatus(await api(`/firmware-builds/stations/${stationId}`));
          });
        }}
      >
        <fieldset disabled={busy || pending || building || !status?.available}>
          {form.configuration && (
            <DeviceHardware
              value={form.configuration}
              onChange={(configuration) =>
                setForm((old) => ({
                  ...old,
                  configuration,
                  purpose: configuration.interface === 'davis-iss-rs485-capture' ? 'usb' : old.purpose,
                }))
              }
            />
          )}
          <div className="form-grid">
            <label>
              Gateway IP / DNS-navn
              <input {...field('mqttHost')} required autoComplete="off" placeholder="wg-api.skrg.no" />
            </label>
            <label>
              MQTT-port (TLS)
              <input {...field('mqttPort')} type="number" required min="1" max="65535" />
            </label>
            <label>
              Wi-Fi SSID
              <input {...field('ssid')} required autoComplete="off" />
            </label>
            <label>
              Wi-Fi-passord
              <input
                {...field('wifiPassword')}
                type="password"
                required={!status?.hasWifiPassword}
                autoComplete="new-password"
                placeholder={status?.hasWifiPassword ? 'Tomt felt beholder lagret passord' : '8–63 byte'}
              />
            </label>
            <label>
              Installasjon
              <select {...field('purpose')}>
                <option value="usb">USB på denne datamaskinen</option>
                <option value="ota" disabled={form.configuration?.interface === 'davis-iss-rs485-capture'}>
                  Nettverk via MQTT/TLS (OTA)
                </option>
              </select>
            </label>
            <label>
              Varighet for nytt enhetssertifikat (år)
              <input {...field('years')} type="number" min="1" max="50" required />
            </label>
          </div>
          <p className="muted small">
            Eksisterende sertifikat og privatnøkkel gjenbrukes. Varighet gjelder nye identiteter og begrenses
            av CA-ens utløpsdato. Wi-Fi-passordet lagres kryptert på kontrollserveren.
          </p>
          <button className="primary" type="submit">
            {building ? 'Serveren kompilerer …' : 'Kompiler på serveren'}
          </button>
        </fieldset>
      </form>
      <p className="muted small">
        ESP-WROOM-32 · RFM69HCW EU868 · standard flashprofil. Denne profilen aktiverer ikke Secure Boot eller
        flashkryptering. Den kan USB-installeres på enheter uten slike eFuses; OTA-installasjon på
        maskinvaresikrede enheter krever tilsvarende signert sikkerhetsprofil.
      </p>
      {status?.builds.map((build) => (
        <div className="firmware-build" key={build.id}>
          <p>
            <strong>{states[build.state] || build.state}</strong> · {build.version || 'ESP32'} ·{' '}
            {build.mqttHost}:{build.mqttPort} · {new Date(build.createdAt).toLocaleString('nb-NO')}
          </p>
          {build.error && <p className="notice error">{build.error}</p>}
          {['queued', 'building'].includes(build.state) && (
            <button
              disabled={busy || pending}
              onClick={() =>
                run(async () => {
                  await api(`/firmware-builds/${build.id}/cancel`, {});
                  setStatus(await api(`/firmware-builds/stations/${stationId}`));
                })
              }
            >
              Avbryt bygg
            </button>
          )}
          {build.state === 'ready' && (
            <div className="actions">
              {build.purpose === 'usb' && onUsbReady && (
                <button
                  disabled={busy || pending}
                  onClick={() =>
                    run(async () => onUsbReady(await api(`/firmware-builds/${build.id}/usb`), build.id))
                  }
                >
                  Klargjør USB-flashing
                </button>
              )}
              {build.purpose === 'ota' && (
                <button
                  disabled={busy || pending}
                  onClick={() =>
                    run(async () => {
                      const change = await api(`/firmware/${build.releaseId}/deploy`, {});
                      await api(`/changes/${change.id}/test`, {});
                      onDeploy?.();
                      setNotice(
                        'OTA-testen er startet. Kontroller enheten og velg «Gjør gjeldende» under Endringer før testfristen utløper.',
                      );
                    })
                  }
                >
                  Start OTA-test
                </button>
              )}
            </div>
          )}
          {build.log && (
            <details open={['building', 'failed'].includes(build.state)}>
              <summary>Bygglogg</summary>
              <pre className="device-terminal" aria-label="Firmware bygglogg">
                {build.log}
              </pre>
            </details>
          )}
        </div>
      ))}
      <details>
        <summary>Importer eksisterende enhetsidentitet</summary>
        <p>
          For en ESP32 som ble klargjort tidligere, importer den opprinnelige enhetspakken (.json). OTA må
          bruke samme privatnøkkel som enheten allerede har. Dette trenger du bare én gang.
        </p>
        <input
          type="file"
          accept=".json"
          aria-label="Eksisterende enhetspakke"
          disabled={busy || pending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void run(async () => {
              if (file.size > 32000) throw new Error('Enhetspakken er for stor.');
              await api(`/firmware-builds/stations/${stationId}/identity`, JSON.parse(await file.text()));
              setStatus(await api(`/firmware-builds/stations/${stationId}`));
            });
          }}
        />
      </details>
    </div>
  );
}
