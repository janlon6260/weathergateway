import React, { useEffect, useRef, useState } from 'react';
import { DeviceSerial, appendTerminal, prepareUsbBundle } from './device-serial.js';
import { FirmwareBuilder } from './firmware-builder.jsx';

export function DeviceTools({ stations, environment, admin, api, initialStationId, onBusy, onDeploy }) {
  const available = stations.filter((s) => s.value.enabled && s.value.model !== 'Netatmo');
  const [stationId, setStationId] = useState(initialStationId || available[0]?.value.id || '');
  const [source, setSource] = useState('usb'),
    [mode, setMode] = useState('disconnected');
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [paused, setPaused] = useState(false);
  const [bundle, setBundle] = useState(null),
    [checked, setChecked] = useState(false),
    [progress, setProgress] = useState(0);
  const [serverBuildId, setServerBuildId] = useState(null);
  const [flashPhase, setFlashPhase] = useState('');
  const [activeTool, setActiveTool] = useState(admin ? 'firmware' : 'logs');
  const [network, setNetwork] = useState(false),
    [networkState, setNetworkState] = useState(''),
    [baud, setBaud] = useState(115200);
  const [search, setSearch] = useState('');
  const apiRef = useRef(api),
    terminal = useRef(null),
    mounted = useRef(true),
    pausedRef = useRef(false);
  apiRef.current = api;
  pausedRef.current = paused;
  const controller = useRef(null);
  if (!controller.current)
    controller.current = new DeviceSerial({
      output: (chunk) => {
        if (mounted.current && !pausedRef.current) setText((old) => appendTerminal(old, chunk));
      },
      state: (next) => {
        if (mounted.current) setMode(next);
      },
      error: (e) => {
        if (mounted.current) setError(e.message);
      },
    });
  const busy = mode === 'flashing' || mode === 'connecting';
  const usbAvailable = window.isSecureContext && !!navigator.serial;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (controller.current.mode !== 'flashing') void controller.current.disconnect();
    };
  }, []);
  useEffect(() => {
    if (initialStationId) setStationId(initialStationId);
  }, [initialStationId]);
  useEffect(() => {
    setBundle(null);
    setServerBuildId(null);
    setChecked(false);
  }, [stationId, environment]);
  useEffect(() => {
    if (!busy) return;
    const prevent = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [busy]);
  useEffect(() => {
    if (!paused && terminal.current) terminal.current.scrollTop = terminal.current.scrollHeight;
  }, [text, paused]);
  useEffect(() => {
    if (!network || !stationId) return;
    let stopped = false,
      cursor = 0,
      sessionId,
      timer,
      renewAt = 0;
    const path = `/devices/${stationId}/logs`;
    const poll = async () => {
      try {
        if (Date.now() >= renewAt) {
          const lease = await apiRef.current(`${path}/session`, {
            seconds: 120,
            ...(sessionId ? { sessionId } : {}),
          });
          sessionId = lease.sessionId;
          renewAt = Date.now() + 60000;
          if (stopped) return;
        }
        const result = await apiRef.current(`${path}?after=${cursor}`);
        if (stopped) return;
        if (result.session?.id !== sessionId)
          throw new Error('En annen loggøkt er startet. Start visningen på nytt.');
        cursor = result.cursor;
        setNetworkState(
          result.device && !result.device.online
            ? 'ESP32 er frakoblet MQTT. Venter på ny forbindelse …'
            : result.session?.state === 'applied'
              ? 'Loggstrøm aktiv via MQTT/TLS'
              : result.session?.state === 'rejected'
                ? 'Enheten avviste loggstrømmen. Kontroller firmwareversjonen.'
                : 'Venter på kvittering fra ESP32 …',
        );
        if (!pausedRef.current && result.entries.length)
          setText((old) =>
            appendTerminal(
              old,
              result.entries
                .map(
                  (line) =>
                    `[${new Date(line.receivedAt).toLocaleTimeString('nb-NO')}] ${line.level.toUpperCase()} +${(line.uptimeMs / 1000).toFixed(1)}s ${line.message.trimEnd()}${line.dropped ? ` [tapte linjer: ${line.dropped}]` : ''}\n`,
                )
                .join(''),
            ),
          );
        if (result.session?.state === 'rejected' || result.session?.state === 'expired') {
          setError(
            'ESP32 svarte ikke på loggkommandoen. Kontroller nettforbindelsen og at firmware 2.1.0 eller nyere er installert.',
          );
          setNetwork(false);
          return;
        }
      } catch (e) {
        if (!stopped) {
          setError(e.message);
          setNetwork(false);
        }
        return;
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      // Best effort stop; the monotonic firmware lease also expires if the browser disappears.
      if (sessionId) void apiRef.current(`${path}/session`, { seconds: 0, sessionId }).catch(() => {});
    };
  }, [network, stationId]);
  async function run(action) {
    setError('');
    try {
      await action();
    } catch (e) {
      if (e.name !== 'NotFoundError') setError(e.message);
    }
  }
  async function load(file) {
    setBundle(null);
    setServerBuildId(null);
    setChecked(false);
    if (!file) return;
    if (file.size > 3000000) throw new Error('USB-pakken er for stor (maks. 3 MB).');
    const prepared = await prepareUsbBundle(JSON.parse(await file.text()), stationId, environment);
    await apiRef.current(`/devices/${stationId}/flash/verify`, {
      manifest: prepared.manifest,
      signature: prepared.signature,
    });
    setBundle(prepared);
  }
  function save() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `esp32-${stationId || 'usb'}-${source}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="panel device-tools" id="device-tools">
      <div className="panel-heading">
        <h2>ESP32 · USB-flashing og sanntidslogg</h2>
      </div>
      <div className="settings-form">
        <div className="tool-tabs" role="tablist" aria-label="ESP32-verktøy">
          {admin && (
            <button
              role="tab"
              aria-selected={activeTool === 'firmware'}
              disabled={busy || network || mode !== 'disconnected'}
              onClick={() => setActiveTool('firmware')}
            >
              Firmware og flashing
            </button>
          )}
          <button
            role="tab"
            aria-selected={activeTool === 'logs'}
            disabled={busy || network || mode !== 'disconnected'}
            onClick={() => setActiveTool('logs')}
          >
            Sanntidslogger
          </button>
        </div>
        <div className="form-grid">
          <label>
            Stasjon
            <select
              value={stationId}
              disabled={busy || network}
              onChange={(e) => setStationId(e.target.value)}
            >
              {!available.length && <option value="">Ingen aktive ESP32-stasjoner</option>}
              {available.map((s) => (
                <option key={s.value.id} value={s.value.id}>
                  {s.value.name}
                </option>
              ))}
            </select>
          </label>
          {activeTool === 'logs' && (
            <label>
              Loggkilde
              <select
                aria-label="Loggkilde"
                value={source}
                disabled={busy || network || mode !== 'disconnected'}
                onChange={(e) => {
                  setSource(e.target.value);
                  setText('');
                  setError('');
                }}
              >
                <option value="usb">USB på denne datamaskinen</option>
                <option value="mqtt">Nettverk via gateway/MQTT</option>
              </select>
            </label>
          )}
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {admin && stationId && activeTool === 'firmware' && (
          <FirmwareBuilder
            key={`${environment}:${stationId}`}
            onDeleted={(buildId) => {
              if (serverBuildId === buildId) {
                setBundle(null);
                setServerBuildId(null);
                setChecked(false);
              }
            }}
            stationId={stationId}
            api={api}
            busy={busy}
            onDeploy={onDeploy}
            onUsbReady={async (input, buildId) => {
              const prepared = await prepareUsbBundle(input, stationId, environment);
              await apiRef.current(`/devices/${stationId}/flash/verify`, {
                manifest: prepared.manifest,
                signature: prepared.signature,
              });
              setBundle(prepared);
              setServerBuildId(buildId);
              setChecked(false);
              setSource('usb');
            }}
          />
        )}
        {source === 'usb' || activeTool === 'firmware' ? (
          <>
            {!usbAvailable && (
              <p className="notice">
                USB krever Chrome eller Edge på en datamaskin. Åpne adminpanelet med HTTPS eller localhost.
              </p>
            )}
            {activeTool === 'logs' && (
              <>
                <div className="actions">
                  <label>
                    Hastighet
                    <select
                      value={baud}
                      disabled={mode !== 'disconnected'}
                      onChange={(e) => setBaud(Number(e.target.value))}
                    >
                      {[115200, 9600, 19200, 57600, 230400].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={!usbAvailable || mode !== 'disconnected'}
                    onClick={() => run(() => controller.current.readLogs(baud))}
                  >
                    Koble til USB-logg
                  </button>
                  <button
                    disabled={mode !== 'reading'}
                    onClick={() => run(() => controller.current.disconnect())}
                  >
                    Koble fra USB
                  </button>
                </div>
                <p className="muted small">
                  USB: {mode === 'reading' ? 'Leser sanntidslogg' : busy ? 'Opptatt' : 'Frakoblet'}. Standard
                  firmware bruker 115200 baud. Lukk andre programmer som bruker COM-porten.
                </p>
              </>
            )}
            {admin && activeTool === 'firmware' && (
              <div className="usb-flash-box">
                <h3>Flash ESP32 via USB</h3>
                <p>
                  Bruk serverbygget ovenfor, eller velg en eksisterende signert USB-pakke. Bootloader og
                  partisjonstabell følger med.
                </p>
                <label>
                  USB-pakke (.usb-flash.json)
                  <input
                    type="file"
                    accept=".json"
                    disabled={busy || !stationId || !usbAvailable}
                    onChange={(e) => run(() => load(e.target.files?.[0]))}
                  />
                </label>
                {bundle && (
                  <p className="notice">
                    Signatur og kontrollsummer godkjent · {bundle.manifest.version} · {environment} ·{' '}
                    {bundle.manifest.stationId}
                  </p>
                )}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={(e) => setChecked(e.target.checked)}
                  />
                  Jeg bekrefter at riktig ESP32 er koblet til. Flashingen sletter alle innstillinger,
                  sertifikater og mellomlagrede målinger på denne ESP-en og installerer pakken.
                </label>
                <p className="muted small">
                  Førstegangsoppsett av Secure Boot/flashkryptering gjøres med ESP-IDF. Allerede
                  maskinvaresikrede enheter oppdateres med signert OTA.
                </p>
                <button
                  className="primary"
                  disabled={!bundle || !checked || !usbAvailable || mode !== 'disconnected'}
                  onClick={() =>
                    run(async () => {
                      setProgress(0);
                      const result = await controller.current.flash(bundle, {
                        progress: setProgress,
                        phase: setFlashPhase,
                        authorize: () =>
                          apiRef.current(`/devices/${stationId}/flash/verify`, {
                            manifest: bundle.manifest,
                            signature: bundle.signature,
                          }),
                      });
                      if (serverBuildId)
                        await apiRef.current(`/firmware-builds/${serverBuildId}/usb-complete`, {
                          bootConfirmed: result.bootConfirmed,
                        });
                      setChecked(false);
                    })
                  }
                >
                  Flash valgt ESP32
                </button>
                {(mode === 'flashing' || progress > 0) && (
                  <div className="flash-progress">
                    <progress max="100" value={progress} aria-label="Flashing og verifisering" />
                    <span>{progress}%</span>
                  </div>
                )}
                {flashPhase && (
                  <p role="status" className="notice">
                    {flashPhase}
                  </p>
                )}
                <p className="muted small">
                  Hvis tilkoblingen stopper: hold BOOT inne mens enheten kobles til, og slipp når chipen er
                  funnet. Koble til USB-loggen etter fullført flashing for å følge oppstarten.
                </p>
              </div>
            )}
          </>
        ) : (
          <>
            <p>
              Loggene sendes kryptert fra ESP32 gjennom gatewayens MQTT-forbindelse. Nettleseren trenger bare
              tilgang til adminpanelet.
            </p>
            <div className="actions">
              <button
                className="primary"
                disabled={network || !stationId}
                onClick={() => {
                  setText('');
                  setError('');
                  setNetwork(true);
                }}
              >
                Start nettverkslogg
              </button>
              <button disabled={!network} onClick={() => setNetwork(false)}>
                Stopp nettverkslogg
              </button>
            </div>
            <p className="muted small" role="status">
              {network ? networkState || 'Starter loggstrøm …' : 'Nettverkslogg stoppet'}. Maksimalt 1000
              linjer per stasjon lagres i én time. ESP-en må ha firmware 2.1.0 eller nyere.
            </p>
          </>
        )}
        {(activeTool === 'logs' || progress > 0 || busy) && (
          <>
            <div className="actions terminal-controls">
              <button onClick={() => setPaused(!paused)}>
                {paused ? 'Fortsett visning' : 'Pause visning'}
              </button>
              <button onClick={() => setText('')}>Tøm visning</button>
              <button disabled={!text} onClick={save}>
                Last ned logg
              </button>
              <label>
                Filtrer linjer
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Søk i loggen"
                />
              </label>
            </div>
            <pre className="device-terminal" ref={terminal} aria-label="ESP32 sanntidslogg" tabIndex="0">
              {text
                ? text
                    .split('\n')
                    .filter((line) => !search || line.toLowerCase().includes(search.toLowerCase()))
                    .join('\n')
                : 'Ingen logglinjer mottatt.'}
            </pre>
            {paused && (
              <p className="muted small">
                Visningen er pauset. Nye linjer vises fra tidspunktet du fortsetter.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
