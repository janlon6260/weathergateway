import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { CertificateAdministration } from './certificates.jsx';
import { DeviceTools } from './device-tools.jsx';
import { DataFreshness, Measurement, FreshnessFields } from './freshness.jsx';
import { dataStatus, freshnessThresholds } from '../../shared/freshness.js';
import { DeviceHealth } from './device-health.jsx';
import { WindReading } from './wind.jsx';
import { ApiClientAdministration } from './api-clients.jsx';
import { deviceInterfaceName } from '../../shared/device-hardware.js';
import { DeviceHardware } from './device-hardware.jsx';
import { NotificationSettings } from './notifications.jsx';
import { meteorologyDefaults, calibrationDefaults } from '../../shared/meteorology-settings.js';
import { alarmMetrics } from '../../shared/alarm-metrics.js';
import {
  databaseColumns,
  extendedDatabaseColumns,
  vatneDatabaseColumns,
} from '../../shared/database-columns.js';

const labels = {
  overview: 'Oversikt',
  stations: 'Stasjoner',
  devices: 'Enheter',
  changes: 'Endringer',
  settings: 'Innstillinger',
  reports: 'Rapporter',
  audit: 'Hendelseslogg',
  databases: 'Databaser',
  firmware: 'Firmware',
  alarms: 'Alarmer',
  readiness: 'Produksjonsstatus',
  certificates: 'Sertifikater',
  connections: 'Tilkoblinger',
};
const pageDescriptions = {
  overview: 'Status og siste målinger fra værstasjonene dine.',
  stations: 'Stasjoner, kalibrering, datakvalitet og eksportfiler.',
  devices: 'Tilkobling, radio og fjernstyring av ESP32-enhetene.',
  changes: 'Test, kontroller og bekreft endringer før fristen løper ut.',
  settings: 'Gateway, innlogging og miljøspesifikke innstillinger.',
  reports: 'Historikk, grafer, klimautdata og rekorder.',
  audit: 'Registrerte handlinger og endringer i dette miljøet.',
  databases: 'Tilkoblinger og levering til stasjonenes værdatabaser.',
  firmware: 'Signerte utgivelser og kontrollert oppdatering av enhetene.',
  alarms: 'Alarmregler, aktive varsler og hendelseshistorikk.',
  readiness: 'Driftskontroller og dokumenterte prøver før produksjon.',
  certificates: 'CA, tjenestesertifikater, ESP32-identiteter og firmware-nøkler.',
  connections: 'Godkjenn tredjepartstilgang til Socket.IO og værdata.',
};
const stateLabels = {
  draft: 'Utkast',
  testing: 'Under testing',
  confirming: 'Venter på enheten',
  confirmed: 'Gjeldende',
  rolled_back: 'Tilbakerullet',
  queued: 'I kø',
  sent: 'Sendt',
  applied: 'Utført',
  received: 'Mottatt',
  rejected: 'Avvist',
  expired: 'Utløpt',
};
const time = (value) => (value ? new Date(value).toLocaleString('nb-NO') : '–');
const value = (x, suffix = '') => (x === '' || x === undefined || x === null ? '–' : `${x}${suffix}`);
function download(name, body) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [session, setSession] = useState(null),
    [loading, setLoading] = useState(true),
    [data, setData] = useState(null),
    [live, setLive] = useState({}),
    [connected, setConnected] = useState(false),
    [page, setPage] = useState('overview'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [modal, setModal] = useState(null),
    [pending, setPending] = useState(false),
    [deviceBusy, setDeviceBusy] = useState(false),
    [now, setNow] = useState(Date.now()),
    [filter, setFilter] = useState(''),
    [selection, setSelection] = useState([]),
    [audit, setAudit] = useState([]);
  const csrf = useRef('');
  const offset = useRef(0);
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`/api${path}`, {
      signal: AbortSignal.timeout(20000),
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf.current }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 && path !== '/login') setSession(null);
      throw new Error(result.fields?.map((f) => `${f.path}: ${f.message}`).join(' · ') || result.error);
    }
    return result;
  }
  async function refresh() {
    const result = await api('/state');
    offset.current = result.now - Date.now();
    setData(result);
    if (session && JSON.stringify(result.principal.roles) !== JSON.stringify(session.principal.roles)) {
      setSession({ ...session, principal: result.principal });
      setPage('overview');
    }
  }
  useEffect(() => {
    let active = true;
    api('/session')
      .then((s) => {
        if (active) {
          csrf.current = s.csrf;
          setSession(s);
        }
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    let active = true;
    const update = () => refresh().catch((e) => active && setError(e.message));
    update();
    const timer = setInterval(update, 5000);
    const events = new EventSource('/api/live/events');
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (e) => {
      if (active) setLive(JSON.parse(e.data));
    };
    return () => {
      active = false;
      clearInterval(timer);
      events.close();
    };
  }, [session]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (page === 'audit' && session)
      api('/audit')
        .then(setAudit)
        .catch((e) => setError(e.message));
  }, [page, session]);
  useEffect(() => {
    if (session && data && location.hash.startsWith('#import=')) {
      try {
        const incoming = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(8)))));
        setModal({ type: 'import', incoming });
        history.replaceState(null, '', location.pathname);
      } catch {
        setError('Overføringspakken kunne ikke leses');
      }
    }
  }, [session, data?.environment]);
  useEffect(() => {
    if (!session) return;
    let last = 0;
    const activity = () => {
      if (Date.now() - last < 60000) return;
      last = Date.now();
      api('/session').catch((e) => setError(e.message));
    };
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    return () => {
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
    };
  }, [session]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement;
    const dialog = document.querySelector('[role="dialog"]');
    const focusable = () =>
      [...dialog.querySelectorAll('button:not(:disabled),input,select,textarea,a[href]')].filter(
        (e) => e.getClientRects().length,
      );
    focusable()[0]?.focus();
    const key = (event) => {
      if (event.key === 'Escape') setModal(null);
      if (event.key !== 'Tab') return;
      const items = focusable(),
        first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [modal?.type]);
  async function action(fn) {
    setPending(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  const admin = session?.principal.roles.includes('administrator'),
    operator = admin || session?.principal.roles.includes('operator');
  async function login(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    setPending(true);
    try {
      const result = await api('/login', { username: form.get('username'), password: form.get('password') });
      csrf.current = result.csrf;
      setSession(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  if (loading) return <main className="loading">Laster administrasjonen …</main>;
  if (!session)
    return (
      <main className="login">
        <div className="login-brand">
          <Logo />
          <span>WEATHER GATEWAY</span>
        </div>
        <section className="login-card">
          <p className="eyebrow">ADMINISTRASJON</p>
          <h1>Logg inn med AD</h1>
          <p>Bruk arbeidskontoen din på internt nett eller VPN.</p>
          <form onSubmit={login}>
            <label>
              Brukernavn
              <input name="username" autoComplete="username" required autoFocus />
            </label>
            <label>
              Passord
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button disabled={pending} className="primary">
              {pending ? 'Logger inn …' : 'Logg inn'} <span>→</span>
            </button>
          </form>
          <p className="muted small">Tilgangen bestemmes av gruppene dine i Active Directory.</p>
        </section>
        <footer>Sunnmørsvær · Weather Gateway</footer>
      </main>
    );
  if (!data)
    return <main className="loading">Henter miljø og stasjoner …{error && <p role="alert">{error}</p>}</main>;
  const environment = data.environment,
    gateway = data.gateway.value;
  const stations = data.stations.filter(
    (s) =>
      (!filter || `${s.value.name} ${s.value.key}`.toLowerCase().includes(filter.toLowerCase())) &&
      (!selection.length || selection.includes(s.value.id)),
  );
  const openChanges = data.changes.filter((c) => ['draft', 'testing', 'confirming'].includes(c.state));
  const currentStatuses = data.stations
    .filter((s) => s.value.model !== 'Netatmo')
    .map(({ value: s }) =>
      dataStatus(live[s.key]?.lastValidTime, now, freshnessThresholds(data.gateway.value, s), s.enabled),
    );
  const visiblePages = Object.keys(labels)
    .filter(
      (p) =>
        !['settings', 'audit', 'databases', 'firmware', 'readiness', 'certificates', 'connections'].includes(
          p,
        ) || admin,
    )
    .filter((p) => p !== 'devices' || operator);
  function scopeName(scope) {
    if (scope === 'notifications') return 'E-postvarsling';
    return scope === 'gateway'
      ? 'Gateway'
      : `${scope.startsWith('device:') ? 'Enhet' : scope.startsWith('database:') ? 'Database' : scope.startsWith('firmware:') ? 'Firmware' : scope.startsWith('alarms:') ? 'Alarmer' : 'Stasjon'} · ${data.stations.find((s) => scope.endsWith(s.value.id))?.value.name || scope}`;
  }
  async function saveChange(scope, item, revision) {
    await api('/changes', { scope, value: item, revision });
    setModal(null);
    setPage('changes');
    setNotice('Utkastet er lagret. Test endringen før du gjør den gjeldende.');
  }
  const renderChanges = (changes) =>
    changes.map((c) => (
      <article className="change-card" key={c.id}>
        <div className="spread">
          <div>
            <span className={`badge ${c.state}`}>{stateLabels[c.state]}</span>
            <h3>{scopeName(c.scope)}</h3>
            <p className="muted small">Opprettet {time(c.created_at)}</p>
          </div>
          {['testing', 'confirming'].includes(c.state) && (
            <div className="countdown">
              <strong>{Math.max(0, Math.ceil((c.deadline - now) / 1000))} s</strong>
              <span>til tilbakerulling</span>
            </div>
          )}
        </div>
        <div className="diff">
          {Object.keys(c.candidate)
            .filter((k) => JSON.stringify(c.before[k]) !== JSON.stringify(c.candidate[k]))
            .map((k) => (
              <div key={k}>
                <span>{k}</span>
                <del>
                  {typeof c.before[k] === 'object' ? JSON.stringify(c.before[k]) : String(c.before[k])}
                </del>
                <b>
                  {typeof c.candidate[k] === 'object'
                    ? JSON.stringify(c.candidate[k])
                    : String(c.candidate[k])}
                </b>
              </div>
            ))}
        </div>
        {c.reason && <p className="muted">Årsak: {c.reason}</p>}
        {c.state === 'testing' && !c.health && (
          <p className="muted">Venter på vellykket helsesjekk fra enheten.</p>
        )}
        {c.state === 'testing' &&
          c.scope === 'gateway' &&
          c.before.adminOrigin !== c.candidate.adminOrigin && (
            <p>
              Bekreft adresseendringen gjennom{' '}
              <a href={c.candidate.adminOrigin} target="_blank" rel="noopener noreferrer">
                den nye adminadressen ↗
              </a>{' '}
              før fristen utløper.
            </p>
          )}
        <div className="actions">
          {c.state === 'draft' && (
            <button
              className="primary"
              disabled={pending}
              onClick={() => action(() => api(`/changes/${c.id}/test`, {}))}
            >
              Test endringen
            </button>
          )}
          {c.state === 'testing' && (
            <button
              className="primary"
              disabled={pending || !c.health || now - c.health.at > 30000}
              onClick={() => action(() => api(`/changes/${c.id}/confirm`, {}))}
            >
              Gjør gjeldende
            </button>
          )}
          {['draft', 'testing', 'confirming'].includes(c.state) && (
            <button disabled={pending} onClick={() => action(() => api(`/changes/${c.id}/cancel`, {}))}>
              Avbryt{c.state !== 'draft' ? ' og gjenopprett' : ''}
            </button>
          )}
        </div>
      </article>
    ));
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Weather Gateway">
          <Logo />
          <span>
            WEATHER
            <br />
            <b>GATEWAY</b>
          </span>
        </a>
        <p className="nav-caption">ARBEIDSOMRÅDE</p>
        <nav>
          {visiblePages.map((p) => (
            <button
              key={p}
              disabled={deviceBusy}
              className={page === p ? 'active' : ''}
              onClick={() => setPage(p)}
            >
              <span className="nav-icon" aria-hidden="true">
                {['◈', '▤', '⌁', '↻', '⚙', '▥', '≡', '▦', '⇧', '♧', '✓', '◇'][
                  Object.keys(labels).indexOf(p)
                ] || '⇄'}
              </span>
              {labels[p]}
              {p === 'changes' && openChanges.length > 0 && (
                <span className="nav-count">{openChanges.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className={`connection ${connected ? 'online' : ''}`}>
            <i />
            {connected ? 'Sanntid tilkoblet' : 'Kobler til sanntid'}
          </span>
          <p>{session.principal.name}</p>
          <small>{session.principal.roles.join(' · ')}</small>
          <button
            onClick={() =>
              action(async () => {
                if (deviceBusy) return;
                await api('/logout', {});
                setSession(null);
              })
            }
          >
            Logg ut ↗
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="breadcrumb">
            Administrasjon <span>/</span> {labels[page]}
          </span>
          <div className="top-actions">
            <span className={`environment ${environment}`}>
              {environment === 'production' ? 'PRODUKSJON' : 'UTVIKLING'}
            </span>
            {(gateway.developmentOrigin || gateway.productionOrigin) && (
              <button
                onClick={() => {
                  const target =
                    environment === 'development' ? gateway.productionOrigin : gateway.developmentOrigin;
                  if (deviceBusy) return;
                  if (target) location.assign(target);
                  else setNotice('Det andre miljøets adresse må konfigureres i innstillingene.');
                }}
              >
                Bytt miljø ⇄
              </button>
            )}
          </div>
        </header>
        {environment !== 'production' && (
          <div className="environment-banner">
            <strong>Utviklingsmiljø</strong> Endringene dine lagres ikke i produksjon.
          </div>
        )}
        <main className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">WEATHER GATEWAY</p>
              <h1>{labels[page]}</h1>
              <p className="muted">{pageDescriptions[page]}</p>
            </div>
            {page === 'stations' && operator && (
              <button className="primary" onClick={() => setModal({ type: 'station' })}>
                ＋ Legg til stasjon
              </button>
            )}
            {page === 'changes' && admin && environment === 'development' && (
              <button
                onClick={() =>
                  action(async () => setModal({ type: 'promotion', incoming: await api('/promotion') }))
                }
              >
                Overfør til produksjon ↗
              </button>
            )}
            {page === 'changes' && admin && environment === 'production' && (
              <button onClick={() => setModal({ type: 'import' })}>Importer fra utvikling</button>
            )}
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button aria-label="Lukk feilmelding" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button aria-label="Lukk melding" onClick={() => setNotice('')}>
                ×
              </button>
            </div>
          )}
          {['overview', 'stations'].includes(page) && (
            <>
              <div className="stats-grid">
                <Stat
                  label="Værstasjoner"
                  number={data.stations.length}
                  detail="Registrert i dette miljøet"
                />
                <Stat
                  label="Tilkoblet"
                  number={currentStatuses.filter((status) => status === 'green').length}
                  detail="Ferske og gyldige målinger"
                  tone="green"
                />
                <Stat
                  label="Trenger oppfølging"
                  number={currentStatuses.filter((status) => ['orange', 'red'].includes(status)).length}
                  detail="Forsinkede data eller sensorfeil"
                  tone="amber"
                />
                <Stat
                  label="Åpne endringer"
                  number={openChanges.length}
                  detail="Utkast eller aktive tester"
                />
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Sanntidsdata</h2>
                    <p className="muted small">
                      Siste mottatte verdier beholdes. Grønn: fersk · oransje: forsinket · rød: for gammel.
                      Standardgrenser: 3 og 30 sekunder.
                    </p>
                  </div>
                  <input
                    className="search"
                    aria-label="Søk etter stasjon"
                    placeholder="Søk etter stasjon …"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
                <div className="station-filters">
                  <button className={!selection.length ? 'selected' : ''} onClick={() => setSelection([])}>
                    Alle stasjoner
                  </button>
                  {data.stations.map((s) => (
                    <button
                      className={selection.includes(s.value.id) ? 'selected' : ''}
                      key={s.value.id}
                      onClick={() =>
                        setSelection((old) =>
                          old.includes(s.value.id)
                            ? old.filter((v) => v !== s.value.id)
                            : [...old, s.value.id],
                        )
                      }
                    >
                      {s.value.name}
                    </button>
                  ))}
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Stasjon</th>
                        <th>Status</th>
                        <th>Temperatur</th>
                        <th>Vind</th>
                        <th>Luftfuktighet</th>
                        <th>Trykk</th>
                        <th>Nedbør i dag</th>
                        <th>Måletid</th>
                        {operator && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {stations.map((s) => {
                        const l = live[s.value.key] || {};
                        return (
                          <tr key={s.value.id}>
                            <td>
                              <strong>{s.value.name}</strong>
                              <small>{s.value.model}</small>
                            </td>
                            <td>
                              <DataFreshness
                                station={s.value}
                                gateway={data.gateway.value}
                                data={l}
                                now={now}
                              />
                            </td>
                            <td className="number">
                              <Measurement
                                data={l}
                                metric="temperatureC"
                                alias="temp"
                                suffix=" °C"
                                now={now}
                              />
                            </td>
                            <td>
                              <WindReading data={l} now={now} />
                            </td>
                            <td>
                              <Measurement data={l} metric="humidityPct" alias="hum" suffix=" %" now={now} />
                            </td>
                            <td>
                              <Measurement
                                data={l}
                                metric="pressureHpa"
                                alias="press"
                                suffix=" hPa"
                                now={now}
                              />
                            </td>
                            <td>
                              <Measurement
                                data={l}
                                metric="rainTodayMm"
                                alias="rfall"
                                suffix=" mm"
                                now={now}
                              />
                            </td>
                            <td className="small">{l.lastValidTime ? time(l.lastValidTime) : '–'}</td>
                            {operator && (
                              <td>
                                <button
                                  className="text-button"
                                  onClick={() => setModal({ type: 'station', record: s })}
                                >
                                  Endre ↗
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!stations.length && <p className="empty">Ingen stasjoner samsvarer med valget.</p>}
              </section>
              {page === 'overview' && openChanges.length > 0 && (
                <section className="section">
                  <h2>Venter på oppfølging</h2>
                  {renderChanges(openChanges.slice(0, 3))}
                </section>
              )}
            </>
          )}
          {page === 'connections' && admin && (
            <ApiClientAdministration
              clients={data.apiClients || []}
              stations={data.stations}
              api={api}
              onSaved={refresh}
            />
          )}
          {page === 'devices' && (
            <>
              <div className="device-grid">
                {data.devices.map((device) => {
                  const station = data.stations.find((s) => s.value.id === device.value.stationId)?.value;
                  return (
                    <section className="panel device" key={device.scope}>
                      <div className="spread">
                        <span className="device-icon">⌁</span>
                        <DataFreshness
                          station={station}
                          gateway={data.gateway.value}
                          data={live[station?.key]}
                          now={now}
                        />
                      </div>
                      <h2>{station?.name}</h2>
                      <p className="muted">ESP-WROOM-32 · {deviceInterfaceName(device.value)}</p>
                      <DeviceHealth health={device.delivery} now={now} />
                      <details className="device-details">
                        <summary>Enhetsoppsett og ISS-radio</summary>
                        <dl>
                          <dt>Gateway</dt>
                          <dd>
                            {device.value.mqttHost}:{device.value.mqttPort}
                          </dd>
                          <dt>
                            {device.value.interface === 'davis-iss-rfm69'
                              ? 'Kontaktmelding'
                              : 'Måleintervall'}
                          </dt>
                          <dd>{device.value.sampleSeconds} sekunder</dd>
                          {device.value.interface === 'davis-iss-rfm69' && (
                            <>
                              <dt>ISS sender-ID</dt>
                              <dd>{device.value.transmitterId}</dd>
                              <dt>Radiosignal</dt>
                              <dd>
                                {typeof device.telemetry?.rssiDbm === 'number'
                                  ? `${device.telemetry.rssiDbm} dBm · kanal ${device.telemetry.channel + 1}`
                                  : 'Ingen mottatt pakke'}
                              </dd>
                              <dt>ISS-batteri</dt>
                              <dd>
                                {device.telemetry?.iss
                                  ? device.telemetry.iss.batteryLow
                                    ? 'Lavt batteri meldt'
                                    : 'Ingen batterivarsel meldt'
                                  : 'Ukjent'}
                              </dd>
                            </>
                          )}
                          <dt>Konfigurasjon</dt>
                          <dd>Revisjon {device.revision}</dd>
                          <dt>ESP32 IP-adresse</dt>
                          <dd>{device.delivery?.ipAddress || 'Ikke rapportert'}</dd>
                          <dt>Wi-Fi-signal</dt>
                          <dd>
                            {typeof device.delivery?.wifiRssiDbm === 'number'
                              ? `${device.delivery.wifiRssiDbm} dBm`
                              : 'Ikke rapportert'}
                          </dd>
                          <dt>Identitet</dt>
                          <dd className="monospace small">{device.value.stationId}</dd>
                          <dt>Sendekø på ESP32</dt>
                          <dd>
                            {device.delivery
                              ? `${device.delivery.pending ?? '–'} av ${device.delivery.capacity ?? '–'} plasser`
                              : 'Ingen køstatus mottatt'}
                          </dd>
                          <dt>Målinger som ikke fikk plass</dt>
                          <dd>{device.delivery?.dropped ?? '–'}</dd>
                        </dl>
                      </details>
                      {device.value.interface === 'davis-iss-rfm69' && (
                        <p className="muted small">
                          Lufttrykk er foreløpig ikke tilkoblet.
                          {device.telemetry?.quality?.rainDayIncomplete
                            ? ' Dagens regnsum har ufullstendig dekning.'
                            : ''}
                        </p>
                      )}
                      <div className="actions">
                        <button
                          className="primary"
                          onClick={() => setModal({ type: 'device', record: device })}
                        >
                          Endre innstillinger
                        </button>
                        <button onClick={() => setModal({ type: 'restart', station })}>Restart</button>
                        {admin && (
                          <button disabled={deviceBusy} onClick={() => setPage('certificates')}>
                            Administrer sertifikater
                          </button>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
              <DeviceTools
                stations={data.stations}
                environment={data.environment}
                admin={admin}
                api={api}
                onBusy={setDeviceBusy}
                onDeploy={() => {
                  void refresh().catch((e) => setError(e.message));
                  setPage('changes');
                }}
              />
              <section className="panel">
                <div className="panel-heading">
                  <h2>Siste kommandoer</h2>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Enhet</th>
                        <th>Kommando</th>
                        <th>Status</th>
                        <th>Tidspunkt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.commands.map((c) => (
                        <tr key={c.id}>
                          <td>{data.stations.find((s) => s.value.id === c.station_id)?.value.name}</td>
                          <td>{c.kind}</td>
                          <td>{stateLabels[c.state] || c.state}</td>
                          <td>{time(c.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!data.commands.length && <p className="empty">Ingen kommandoer er sendt ennå.</p>}
              </section>
            </>
          )}
          {page === 'changes' && (
            <>
              {renderChanges(data.changes)}
              {!data.changes.length && (
                <div className="panel empty">
                  <h2>Ingen endringer ennå</h2>
                  <p>Endringer du lagrer fra stasjoner, enheter og innstillinger vises her.</p>
                </div>
              )}
            </>
          )}
          {page === 'settings' && (
            <>
              <Settings
                key={data.gateway.revision}
                record={data.gateway}
                pending={pending}
                save={(item) => action(() => saveChange('gateway', item, data.gateway.revision))}
              />
              <Operations api={api} onError={setError} />
              {admin && data.notifications && (
                <NotificationSettings
                  key={`smtp:${data.notifications.settings.revision}`}
                  data={data.notifications}
                  stations={data.stations}
                  api={api}
                  onSaved={() => {
                    void refresh().catch((e) => setError(e.message));
                    setPage('changes');
                  }}
                />
              )}
            </>
          )}
          {page === 'certificates' && admin && (
            <CertificateAdministration api={api} stations={data.stations} onError={setError} />
          )}
          {page === 'databases' && admin && (
            <section className="panel settings-form">
              <h2>Skriving til eksisterende stasjonsdatabaser</h2>
              <p className="notice">
                Innstillinger lagres i{' '}
                <strong>{data.configurationStorage?.database || 'weathergateway'}</strong>. Stasjonsdatabasene
                mottar bare værdata.
              </p>
              <div className="actions">
                <span
                  className={`status ${data.gateway.value.databaseLoggingEnabled === false ? 'disabled' : 'green'}`}
                >
                  <i />
                  {data.gateway.value.databaseLoggingEnabled === false
                    ? 'MariaDB-logging er satt på pause globalt'
                    : 'Global MariaDB-logging er aktiv'}
                </span>
                <button
                  disabled={pending}
                  onClick={() =>
                    action(() =>
                      saveChange(
                        'gateway',
                        {
                          ...data.gateway.value,
                          databaseLoggingEnabled: data.gateway.value.databaseLoggingEnabled === false,
                        },
                        data.gateway.revision,
                      ),
                    )
                  }
                >
                  {data.gateway.value.databaseLoggingEnabled === false
                    ? 'Aktiver global logging'
                    : 'Sett global logging på pause'}
                </button>
              </div>
              <p>
                Værdata sendes til wx_data etter at tilkoblingen er testet og gjort gjeldende. Køen beholdes
                ved databaseutfall og omstart.
              </p>
              <p className="muted">
                Tillatte databaser:{' '}
                {data.databaseAllowlist?.join(', ') || 'Ingen er konfigurert i WG_DB_ALLOWED_DATABASES.'}
              </p>
              {!!data.databaseLanEndpoints?.length && (
                <p className="muted">Tillatte LAN-mål: {data.databaseLanEndpoints.join(', ')}</p>
              )}
              {environment !== 'production' && (
                <p className="notice">
                  Utvikling kan bare skrive til separate testdatabaser med navn som starter med wg_dev_.
                </p>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Stasjon</th>
                      <th>Databasemål</th>
                      <th>Status</th>
                      <th>I kø</th>
                      <th>Siste leverte måletid</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(data.databases || []).map((record) => (
                      <tr key={record.scope}>
                        <td>
                          {
                            data.stations.find((station) => station.value.id === record.value.stationId)
                              ?.value.name
                          }
                        </td>
                        <td>
                          {record.value.host
                            ? `${record.value.host}/${record.value.database}`
                            : 'Ikke konfigurert'}
                        </td>
                        <td>
                          {record.lastError ||
                            (record.loggingActive
                              ? 'Logger'
                              : record.confirmedEnabled
                                ? 'Logging pauset'
                                : 'Ikke konfigurert')}
                        </td>
                        <td>
                          {record.pending}
                          {record.paused > 0 && ` (${record.paused} venter på tidligere mål)`}
                        </td>
                        <td>{time(record.lastDeliveredAt)}</td>
                        <td>
                          <button onClick={() => setModal({ type: 'database', record })}>Konfigurer</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {page === 'firmware' && admin && (
            <FirmwareManager
              releases={data.firmwareReleases || []}
              stations={data.stations}
              pending={pending}
              build={() => setPage('devices')}
              upload={(file) =>
                action(async () => {
                  await api('/firmware', JSON.parse(await file.text()));
                  setNotice('Signert firmware er lastet opp. Velg utgivelsen for å opprette en test.');
                })
              }
              deploy={(releaseId) =>
                action(async () => {
                  await api(`/firmware/${releaseId}/deploy`, {});
                  setPage('changes');
                })
              }
            />
          )}
          {page === 'alarms' && (
            <>
              <AlarmManager
                data={data.alarms}
                stations={data.stations}
                operator={operator}
                pending={pending}
                configure={(record) => setModal({ type: 'alarms', record })}
                acknowledge={(eventId) => action(() => api(`/alarms/events/${eventId}/acknowledge`, {}))}
              />
              {admin && data.notifications && (
                <NotificationSettings
                  key={`rules:${data.notifications.settings.revision}`}
                  mode="rules"
                  data={data.notifications}
                  stations={data.stations}
                  api={api}
                  onConfigure={() => setPage('settings')}
                  onSaved={() => {
                    void refresh().catch((e) => setError(e.message));
                    setPage('changes');
                  }}
                />
              )}
            </>
          )}
          {page === 'reports' && (
            <Reports stations={data.stations} api={api} onError={setError} admin={admin} />
          )}
          {page === 'readiness' && admin && <ReadinessPanel api={api} onError={setError} />}
          {page === 'audit' && (
            <section className="panel">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Tidspunkt</th>
                      <th>Handling</th>
                      <th>Aktør</th>
                      <th>Detaljer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((e) => (
                      <tr key={e.id}>
                        <td>{time(e.at)}</td>
                        <td>{e.action}</td>
                        <td className="small monospace">{e.actor}</td>
                        <td className="small monospace">{JSON.stringify(e.details)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
        <footer className="workspace-footer">
          <span>Weather Gateway</span>
          <span>
            {environment === 'production' ? 'Produksjonsmiljø' : 'Isolert utviklingsmiljø'} ·{' '}
            {new Date(now).toLocaleTimeString('nb-NO')}
          </span>
        </footer>
      </div>
      {modal && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setModal(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <button className="modal-close" aria-label="Lukk" onClick={() => setModal(null)}>
              ×
            </button>
            {modal.type === 'station' && (
              <StationForm
                record={modal.record}
                globalSettings={data.gateway.value}
                pending={pending}
                save={(item) =>
                  action(async () => {
                    if (modal.record) await saveChange(modal.record.scope, item, modal.record.revision);
                    else {
                      await api('/stations', item);
                      setModal(null);
                      setPage('changes');
                    }
                  })
                }
              />
            )}
            {modal.type === 'device' && (
              <DeviceForm
                record={modal.record}
                pending={pending}
                save={(item) => action(() => saveChange(modal.record.scope, item, modal.record.revision))}
              />
            )}
            {modal.type === 'alarms' && (
              <AlarmForm
                record={modal.record}
                pending={pending}
                save={(item) => action(() => saveChange(modal.record.scope, item, modal.record.revision))}
              />
            )}
            {modal.type === 'database' && (
              <DatabaseForm
                record={modal.record}
                pending={pending}
                passwordKeys={data.databasePasswordKeys || []}
                test={(item) => api(`/databases/${item.stationId}/test`, item)}
                save={(item) => action(() => saveChange(modal.record.scope, item, modal.record.revision))}
              />
            )}
            {modal.type === 'restart' && (
              <>
                <h2 id="modal-title">Restart {modal.station.name}</h2>
                <p>Enheten kobles fra mens den starter på nytt. Gjeldende innstillinger beholdes.</p>
                <button
                  className="primary"
                  disabled={pending}
                  onClick={() =>
                    action(async () => {
                      await api(`/devices/${modal.station.id}/restart`, {});
                      setModal(null);
                      setNotice('Restart er bestilt. Følg kvitteringen under Enheter.');
                    })
                  }
                >
                  Start enheten på nytt
                </button>
              </>
            )}
            {['promotion', 'import'].includes(modal.type) && (
              <Promotion
                incoming={modal.incoming}
                exporting={modal.type === 'promotion'}
                target={gateway.productionOrigin}
                pending={pending}
                submit={(incoming) =>
                  action(async () => {
                    await api('/promotion', incoming);
                    setModal(null);
                    setPage('changes');
                    setNotice(
                      'Pakken er importert som utkast. Hver produksjonsendring må testes og bekreftes.',
                    );
                  })
                }
              />
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Logo() {
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        d="M9 27h21a7 7 0 0 0 0-14 10 10 0 0 0-19-1 8 8 0 0 0-2 15Z"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <path d="m15 31 4-9m3 10 4-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
function Stat({ label, number, detail, tone = '' }) {
  return (
    <section className={`stat ${tone}`}>
      <span>{label}</span>
      <strong>
        {number}
        <i />
      </strong>
      <small>{detail}</small>
    </section>
  );
}
function Field({ label, name, item, set, type = 'text', ...props }) {
  return (
    <label>
      {label}
      <input
        {...props}
        type={type}
        value={item[name] ?? ''}
        onChange={(e) =>
          set({ ...item, [name]: type === 'number' ? Number(e.target.value) : e.target.value })
        }
      />
    </label>
  );
}
function DatabaseForm({ record, pending, passwordKeys, save, test }) {
  const [item, set] = useState({
    ...structuredClone(record.value),
    transport: record.value.transport === 'tls' ? 'tls' : 'lan',
    stationNameColumn: record.value.stationNameColumn ?? '',
  });
  const [columns, setColumns] = useState(JSON.stringify(record.value.columns, null, 2));
  const [databasePassword, setDatabasePassword] = useState('');
  const [formError, setFormError] = useState('');
  const [testMessage, setTestMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (callback) => {
    try {
      const parsed = JSON.parse(columns);
      setFormError('');
      setTestMessage('');
      setBusy(true);
      const report = await callback({
        ...item,
        stationNameColumn: item.stationNameColumn || null,
        columns: parsed,
        ...(databasePassword ? { password: databasePassword } : {}),
      });
      if (report?.database)
        setTestMessage(
          report.database === 'disabled'
            ? 'Databaseskriving er deaktivert.'
            : 'Tilkobling og tabellskjema er godkjent. Testen skrev ingen værdata.',
        );
    } catch (error) {
      setFormError(error instanceof SyntaxError ? 'Feltkoblingen må være gyldig JSON.' : error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit(save);
      }}
    >
      <h2 id="modal-title">Database for {item.stationKey}</h2>
      <p>
        Bruk tilkoblingen til stasjonens eksisterende wx_data-tabell på privat lokalnett. TLS kan velges
        dersom databaseserveren er satt opp for det.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={item.enabled}
          onChange={(event) => set({ ...item, enabled: event.target.checked })}
        />{' '}
        Konfigurer og aktiver denne databasetilkoblingen etter bekreftelse
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={item.loggingEnabled !== false}
          onChange={(e) => set({ ...item, loggingEnabled: e.target.checked })}
        />
        Logg værdata fra denne stasjonen til MariaDB
      </label>
      <label>
        Databasepassord
        <input
          type="password"
          autoComplete="new-password"
          value={databasePassword}
          onChange={(e) => setDatabasePassword(e.target.value)}
          placeholder={
            item.passwordSecret
              ? 'Tomt felt beholder kryptert lagret passord'
              : 'Kan angis her; lagres kryptert i weathergateway'
          }
        />
      </label>
      <div className="form-grid">
        <Field
          label="Databasevert (IP eller FQDN)"
          name="host"
          item={item}
          set={set}
          required={item.enabled}
        />
        <Field label="Port" name="port" type="number" min="1" max="65535" item={item} set={set} required />
        <label>
          Transport
          <select
            value={item.transport}
            onChange={(event) => set({ ...item, transport: event.target.value })}
          >
            <option value="lan">Privat lokalnett (uten TLS)</option>
            <option value="tls">TLS med sertifikatkontroll</option>
          </select>
        </label>
        <Field label="Databasenavn" name="database" item={item} set={set} required={item.enabled} />
        <Field
          label="Skrivebruker"
          name="user"
          item={item}
          set={set}
          required={item.enabled}
          autoComplete="off"
        />
        <Field label="Stasjonsnavn i station_id" name="stationKey" item={item} set={set} required />
        <Field
          label="Kolonne for stasjonsnavn (valgfri, Vatne: station_name)"
          name="stationNameColumn"
          item={item}
          set={set}
        />
        <Field
          label="Lagringsintervall (sekunder)"
          name="intervalSeconds"
          type="number"
          min="1"
          max="86400"
          item={item}
          set={set}
          required
        />
        <Field
          label="Passordvariabel i .env"
          name="passwordEnv"
          item={item}
          set={set}
          required
          list="database-password-keys"
        />
        <datalist id="database-password-keys">
          {passwordKeys.map((key) => (
            <option value={key} key={key} />
          ))}
        </datalist>
        <label>
          Vindenhet i databasen
          <select value={item.windUnit} onChange={(event) => set({ ...item, windUnit: event.target.value })}>
            <option value="kmh">km/t (eksisterende standard)</option>
            <option value="ms">m/s</option>
          </select>
        </label>
      </div>
      {item.transport === 'lan' && (
        <p className="notice">
          Gatewayen kobler direkte til SQL-serveren på lokalnettet. Vert og port må stå i WG_DB_LAN_ENDPOINTS
          og peke på en privat adresse. TLS eller VPN er ikke påkrevd i denne modusen.
        </p>
      )}
      <p className="muted small">
        Passord angitt her lagres kryptert i weathergateway. Eksisterende .env-passord brukes når eget passord
        ikke er lagret. Privat database-CA kan angis med WG_DB_CA_FILE. Databasemålet må være tillatt i
        WG_DB_ALLOWED_DATABASES for dette miljøet.
      </p>
      <label>
        Feltkobling til wx_data (JSON; null utelater en måling)
        <textarea
          rows="12"
          value={columns}
          onChange={(event) => setColumns(event.target.value)}
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        onClick={() =>
          setColumns(
            JSON.stringify(
              {
                ...databaseColumns,
                ...extendedDatabaseColumns,
                uvIndex: item.stationKey.toLowerCase() === 'hahjem' ? 'davis_vp_uv' : null,
                ...(item.stationKey.toLowerCase() === 'vatne' ? vatneDatabaseColumns : {}),
              },
              null,
              2,
            ),
          )
        }
      >
        Foreslå Weather Display-feltkobling (må testes)
      </button>
      {record.pending > 0 && (
        <p className="notice">
          {record.pending} rader venter på levering. Lever køen før du endrer databasemål, stasjonsnavn,
          enheter eller feltkobling. Rader til tidligere mål beholdes i køen.
        </p>
      )}
      {formError && <p role="alert">{formError}</p>}
      {testMessage && <p role="status">{testMessage}</p>}
      <div className="actions">
        <button type="button" disabled={pending || busy} onClick={() => submit(test)}>
          Test tilkobling og skjema
        </button>
        <button className="primary" disabled={pending || busy} type="submit">
          Lagre utkast
        </button>
      </div>
    </form>
  );
}
function StationForm({ record, pending, save, globalSettings }) {
  const [item, set] = useState({
    ...(record?.value || {
      name: '',
      key: '',
      model: 'Davis Vantage Pro2',
      enabled: true,
      latitude: 0,
      longitude: 0,
      elevationM: 0,
      exportName: 'station-wd.txt',
      rainCounterMmPerUnit: 0.2,
    }),
    meteorology: { ...meteorologyDefaults, ...record?.value.meteorology },
    calibration: { ...calibrationDefaults, ...record?.value.calibration },
    templates: record?.value.templates || [],
    qualityRules: record?.value.qualityRules || [],
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(item);
      }}
    >
      <p className="eyebrow">STASJONSREGISTER</p>
      <h2 id="modal-title">{record ? 'Endre stasjon' : 'Legg til værstasjon'}</h2>
      <div className="form-grid">
        <Field label="Navn" name="name" item={item} set={set} required />
        <Field label="Publiseringsnøkkel" name="key" item={item} set={set} required />
        <label>
          Modell
          <select value={item.model} onChange={(e) => set({ ...item, model: e.target.value })}>
            <option>Davis Vantage Pro2</option>
            <option>Davis Vantage Vue</option>
          </select>
        </label>
        <Field label="Eksportfil" name="exportName" item={item} set={set} required />
        <Field label="Breddegrad" name="latitude" type="number" step="any" item={item} set={set} />
        <Field label="Lengdegrad" name="longitude" type="number" step="any" item={item} set={set} />
        <Field label="Høyde over havet (m)" name="elevationM" type="number" item={item} set={set} />
        <Field
          label="Nedbør per telleenhet (mm)"
          name="rainCounterMmPerUnit"
          type="number"
          step="0.01"
          item={item}
          set={set}
        />
      </div>
      <FreshnessFields item={item} set={set} globalSettings={globalSettings} />
      <h3>Meteorologiske beregninger</h3>
      <div className="form-grid">
        {[
          ['windWindowSeconds', 'Middelvind: tidsvindu (sekunder)', 60, 3600, 1],
          ['maximumGapSeconds', 'Største datagap som tidsmidles (sekunder)', 3, 300, 1],
          ['minimumCoverage', 'Minste datadekning (0,5–1)', 0.5, 1, 0.01],
          ['windHeightM', 'Vindmålerens høyde over bakken (m)', 0.5, 100, 0.1],
          ['heatingBaseC', 'Grunnlag for varme-/kjølegraddager (°C)', -20, 40, 'any'],
          ['growingBaseC', 'Grunnlag for vekstgraddager (°C)', -20, 40, 0.1],
          ['growingCeilingC', 'Øvre grense for vekstgraddager (°C)', -10, 60, 0.1],
          ['sunshineThresholdWm2', 'Solskinnsestimat: grense for globalstråling (W/m²)', 1, 1500, 1],
          ['rainDayStartHour', 'Nedbørsdøgn i rapporter: starttime (Oslo)', 0, 23, 1],
          ['wetDayThresholdMm', 'Grense for vått døgn (mm)', 0.01, 100, 0.01],
        ].map(([name, label, min, max, step]) => (
          <Field
            key={name}
            name={name}
            label={label}
            type="number"
            min={min}
            max={max}
            step={step}
            item={item.meteorology}
            set={(meteorology) => set({ ...item, meteorology })}
            required
          />
        ))}
      </div>
      <p className="muted small">
        Kontroller vindmålerens faktiske høyde. Solskinn fra globalstråling er et estimat. Beregninger med
        utilstrekkelig datadekning vises som manglende.
      </p>
      <h3>Kalibrering</h3>
      <div className="form-grid">
        {[
          ['temperatureOffsetC', 'Temperaturkorreksjon (°C)', -20, 20],
          ['humidityOffsetPct', 'Fuktighetskorreksjon (prosentpoeng)', -50, 50],
          ['pressureOffsetHpa', 'Trykkorreksjon (hPa)', -100, 100],
          ['windFactor', 'Faktor for vindhastighet', 0.01, 10],
          ['windDirectionOffsetDeg', 'Retningskorreksjon (grader)', -360, 360],
          ['solarFactor', 'Faktor for solstråling', 0.01, 10],
        ].map(([name, label, min, max]) => (
          <Field
            key={name}
            name={name}
            label={label}
            type="number"
            min={min}
            max={max}
            step="0.01"
            item={item.calibration}
            set={(calibration) => set({ ...item, calibration })}
            required
          />
        ))}
      </div>
      <p className="muted small">
        Råmålinger beholdes. Kalibrering gjelder nye målinger etter «Gjør gjeldende».
      </p>
      <TemplateEditor templates={item.templates} set={(templates) => set({ ...item, templates })} />
      <QualityRulesEditor rules={item.qualityRules} set={(qualityRules) => set({ ...item, qualityRules })} />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={item.enabled}
          onChange={(e) => set({ ...item, enabled: e.target.checked })}
        />
        Stasjonen er aktiv
      </label>
      <button className="primary" disabled={pending}>
        Lagre som utkast
      </button>
    </form>
  );
}
function FirmwareManager({ releases, stations, pending, upload, deploy, build }) {
  return (
    <section className="panel settings-form">
      <h2>Signerte firmwareutgivelser</h2>
      <p>
        Bygg firmware på serveren under Enheter med gatewayadresse, MQTT-port og Wi-Fi. En OTA-test må
        bekreftes innen fristen etter at enheten har startet og sendt gyldige sensordata. Du kan også
        importere en ferdig signert utgivelse nedenfor.
      </p>
      <button className="primary" onClick={build}>
        Bygg ny firmware på serveren
      </button>
      <label>
        Utgivelsesfil (JSON)
        <input
          type="file"
          accept="application/json,.json"
          disabled={pending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = '';
          }}
        />
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Stasjon</th>
              <th>Versjon</th>
              <th>Sekvens</th>
              <th>Størrelse</th>
              <th>Handling</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr key={release.id}>
                <td>{stations.find((s) => s.value.id === release.station_id)?.value.name}</td>
                <td>{release.manifest.version}</td>
                <td>{release.manifest.sequence}</td>
                <td>{Math.ceil(release.manifest.size / 1024)} kB</td>
                <td>
                  {release.installation === 'usb' ? (
                    <button onClick={build}>Installer via USB under Enheter</button>
                  ) : (
                    <button disabled={pending} onClick={() => deploy(release.id)}>
                      Opprett testutkast
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!releases.length && <p className="empty">Ingen utgivelser er lastet opp.</p>}
    </section>
  );
}
function DeviceForm({ record, pending, save }) {
  const [item, set] = useState(record.value);
  if (item.interface === 'davis-iss-rs485-capture')
    return (
      <div className="settings-form">
        <h2 id="modal-title">RS-485-opptaksprofil</h2>
        <p>
          Dette er en mottaksprofil for å dokumentere den kablede ISS-protokollen. Endre GPIO, UART-hastighet
          og nettverk ved å bygge en ny USB-pakke under Enheter.
        </p>
        <fieldset disabled>
          <DeviceHardware value={item} onChange={() => {}} />
        </fieldset>
      </div>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(item);
      }}
    >
      <p className="eyebrow">ESP32</p>
      <h2 id="modal-title">Enhetsinnstillinger</h2>
      <p className="muted">Innstillingene testes på enheten. De beholdes bare etter bekreftelse.</p>
      {item.interface === 'davis-iss-rfm69' && (
        <p className="muted">
          Davis ISS · RFM69HCW · Europa 868 MHz. Sender-ID må samsvare med ISS. Standardverdien 1 er et
          oppsettvalg og må kontrolleres på stasjonen.
        </p>
      )}
      <div className="form-grid">
        <Field label="Gatewayens vertsnavn" name="mqttHost" item={item} set={set} required />
        <Field label="MQTT-port (TLS)" name="mqttPort" type="number" item={item} set={set} />
        <Field
          label={
            item.interface === 'davis-iss-rfm69'
              ? 'Intervall for kontaktmelding (sekunder)'
              : 'Måleintervall (sekunder)'
          }
          name="sampleSeconds"
          type="number"
          item={item}
          set={set}
        />
        {item.interface === 'davis-iss-rfm69' ? (
          <>
            <label>
              ISS sender-ID
              <select
                value={item.transmitterId}
                onChange={(e) => set({ ...item, transmitterId: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <Field label="SPI SCK GPIO" name="spiSck" type="number" item={item} set={set} />
            <Field label="SPI MISO GPIO" name="spiMiso" type="number" item={item} set={set} />
            <Field label="SPI MOSI GPIO" name="spiMosi" type="number" item={item} set={set} />
            <Field label="Radio CS GPIO" name="radioCs" type="number" item={item} set={set} />
            <Field label="Radio RST GPIO" name="radioReset" type="number" item={item} set={set} />
            <Field label="Radio G0 / DIO0 GPIO" name="radioDio0" type="number" item={item} set={set} />
          </>
        ) : (
          <>
            <label>
              Davis seriell hastighet
              <select value={item.uartBaud} onChange={(e) => set({ ...item, uartBaud: e.target.value })}>
                {['19200', '9600', '2400', '1200'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <Field label="ESP32 RX GPIO" name="uartRx" type="number" item={item} set={set} />
            <Field label="ESP32 TX GPIO" name="uartTx" type="number" item={item} set={set} />
          </>
        )}
      </div>
      <button className="primary" disabled={pending}>
        Lagre som utkast
      </button>
    </form>
  );
}
function Settings({ record, pending, save }) {
  const [item, set] = useState({
      backupIntervalHours: 24,
      backupKeepCount: 30,
      dataWarningSeconds: 3,
      dataDownSeconds: 30,
      databaseLoggingEnabled: true,
      ...record.value,
    }),
    [directory, setDirectory] = useState(JSON.stringify(record.value.directory, null, 2)),
    [localError, setLocalError] = useState('');
  return (
    <form
      className="panel settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          save({
            ...item,
            developmentOrigin: item.developmentOrigin || undefined,
            productionOrigin: item.productionOrigin || undefined,
            directory: JSON.parse(directory),
          });
        } catch {
          setLocalError('AD-innstillingene må være gyldig JSON.');
        }
      }}
    >
      <h2>Gateway</h2>
      <FreshnessFields item={item} set={set} gateway />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={item.databaseLoggingEnabled}
          onChange={(e) => set({ ...item, databaseLoggingEnabled: e.target.checked })}
        />
        Aktiver logging av værdata til MariaDB globalt
      </label>
      <div className="form-grid">
        <Field label="Adminpanelets adresse" name="adminOrigin" item={item} set={set} />
        <Field label="Offentlig API-adresse" name="publicOrigin" item={item} set={set} />
        <Field label="Utviklingsmiljøets adresse" name="developmentOrigin" item={item} set={set} />
        <Field label="Produksjonsmiljøets adresse" name="productionOrigin" item={item} set={set} />
        <Field
          label="Frist for bekreftelse (sekunder)"
          name="confirmationSeconds"
          type="number"
          item={item}
          set={set}
        />
        <Field label="Behold målinger (dager)" name="retentionDays" type="number" item={item} set={set} />
        <Field
          label="Automatisk databasebackup (timer; 0 deaktiverer)"
          name="backupIntervalHours"
          type="number"
          min="0"
          max="168"
          item={item}
          set={set}
        />
        <Field
          label="Antall fullførte databasebackuper som beholdes"
          name="backupKeepCount"
          type="number"
          min="2"
          max="365"
          item={item}
          set={set}
        />
        <Field
          label="Ekstern kompatibilitetsvisning: oransje etter (sekunder)"
          name="warningSeconds"
          type="number"
          item={item}
          set={set}
        />
        <Field
          label="Ekstern kompatibilitetsvisning: rød etter (sekunder)"
          name="downSeconds"
          type="number"
          item={item}
          set={set}
        />
        <Field
          label="Sesjon uten aktivitet (minutter)"
          name="sessionIdleMinutes"
          type="number"
          item={item}
          set={set}
        />
        <Field
          label="Maksimal sesjonslengde (timer)"
          name="sessionAbsoluteHours"
          type="number"
          item={item}
          set={set}
        />
      </div>
      <div className="divider" />
      <h2>Active Directory</h2>
      <p className="muted">
        LDAPS-adresser, søkebase og eksisterende grupper med roller. Passord og private nøkler administreres
        som separate hemmeligheter.
      </p>
      <label>
        Katalog og gruppetilknytning
        <textarea
          rows="16"
          spellCheck="false"
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
        />
      </label>
      {localError && (
        <p role="alert" className="error">
          {localError}
        </p>
      )}
      <button className="primary" disabled={pending}>
        Lagre som utkast
      </button>
    </form>
  );
}
function Promotion({ incoming, exporting, target, pending, submit }) {
  const [text, setText] = useState(incoming ? JSON.stringify(incoming, null, 2) : ''),
    [error, setError] = useState('');
  return (
    <>
      <p className="eyebrow">UTVIKLING → PRODUKSJON</p>
      <h2 id="modal-title">{exporting ? 'Overfør konfigurasjon' : 'Importer konfigurasjon'}</h2>
      <p>
        Produksjonens adresser, AD-grupper og hemmeligheter beholdes. Importen oppretter utkast som må testes
        og bekreftes i produksjon.
      </p>
      <label>
        Overføringspakke
        <textarea
          rows="15"
          value={text}
          readOnly={exporting}
          onChange={(e) => setText(e.target.value)}
          spellCheck="false"
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        {exporting ? (
          <>
            <button onClick={() => download('weathergateway-promotion.json', incoming)}>
              Last ned pakke
            </button>
            {target && (
              <button
                className="primary"
                onClick={() => {
                  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(incoming))));
                  location.assign(`${new URL(target).origin}/#import=${encoded}`);
                }}
              >
                Åpne i produksjon ↗
              </button>
            )}
          </>
        ) : (
          <button
            className="primary"
            disabled={pending}
            onClick={() => {
              try {
                submit(JSON.parse(text));
              } catch {
                setError('Pakken må være gyldig JSON.');
              }
            }}
          >
            Importer som utkast
          </button>
        )}
      </div>
    </>
  );
}
function ReadinessPanel({ api, onError }) {
  const [report, setReport] = useState(null),
    [selected, setSelected] = useState(''),
    [note, setNote] = useState(''),
    [passed, setPassed] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const reload = () =>
      api('/readiness')
        .then((data) => active && setReport(data))
        .catch((e) => active && onError(e.message));
    reload();
    const timer = setInterval(reload, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  if (!report) return <p>Kontrollerer produksjonsstatus …</p>;
  return (
    <section className="panel settings-form">
      <h2>Produksjonsstatus</h2>
      <p className={report.ready ? 'notice' : 'muted'}>
        {report.ready ? 'Produksjonskontrollene er godkjent.' : 'Produksjonskontrollene er ikke fullført.'}{' '}
        Miljø: {report.environment}.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Kontroll</th>
              <th>Status</th>
              <th>Merknad</th>
            </tr>
          </thead>
          <tbody>
            {report.checks.map((check) => (
              <tr key={check.id}>
                <td>{check.label}</td>
                <td>{check.passed ? 'Godkjent' : 'Gjenstår'}</td>
                <td>
                  {check.detail?.note ||
                    (check.detail?.status === 'unverified' ? 'Ikke verifisert i målmiljøet' : '')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>Registrer en utført akseptanseprøve</summary>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setReport(
                await api('/readiness/evidence', {
                  checkId: selected,
                  configurationHash: report.configurationHash,
                  passed,
                  note,
                }),
              );
              setNote('');
              setPassed(false);
            } catch (e) {
              onError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Utført prøve
            <select required value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Velg prøve</option>
              {report.checks
                .filter((check) => check.detail?.verification === 'manual')
                .map((check) => (
                  <option key={check.id} value={check.id}>
                    {check.label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Faktisk utførelse, resultat og hvor dokumentasjonen finnes
            <textarea
              required
              minLength="20"
              maxLength="2000"
              rows="4"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={passed} onChange={(e) => setPassed(e.target.checked)} />
            Prøven er gjennomført og bestått
          </label>
          <button className="primary" disabled={busy}>
            Registrer resultat
          </button>
        </form>
      </details>
    </section>
  );
}
function QualityRulesEditor({ rules, set }) {
  return (
    <section>
      <h3>Datakvalitet</h3>
      {rules.map((rule, index) => (
        <div className="form-grid" key={index}>
          <label>
            Måling
            <select
              value={rule.metric}
              onChange={(e) => set(rules.map((r, i) => (i === index ? { ...r, metric: e.target.value } : r)))}
            >
              {['temperatureC', 'humidityPct', 'pressureHpa', 'windSpeedMs', 'solarWm2', 'uvIndex'].map(
                (key) => (
                  <option key={key} value={key}>
                    {alarmMetrics[key]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Største endring per minutt (tomt deaktiverer)
            <input
              type="number"
              min="0.001"
              step="any"
              value={rule.maximumChangePerMinute ?? ''}
              onChange={(e) =>
                set(
                  rules.map((r, i) =>
                    i === index
                      ? {
                          ...r,
                          maximumChangePerMinute: e.target.value === '' ? null : Number(e.target.value),
                        }
                      : r,
                  ),
                )
              }
            />
          </label>
          <Field
            label="Varsle uendret verdi etter (sekunder; 0 deaktiverer)"
            name="stuckSeconds"
            type="number"
            min="0"
            max="604800"
            item={rule}
            set={(updated) => set(rules.map((r, i) => (i === index ? updated : r)))}
          />
          <label>
            Ved avvik
            <select
              value={rule.action}
              onChange={(e) => set(rules.map((r, i) => (i === index ? { ...r, action: e.target.value } : r)))}
            >
              <option value="flag">Behold og merk verdien</option>
              <option value="missing">Behandle som manglende</option>
            </select>
          </label>
          <button type="button" onClick={() => set(rules.filter((_, i) => i !== index))}>
            Fjern kvalitetsregel
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={rules.length >= 6}
        onClick={() =>
          set([
            ...rules,
            { metric: 'temperatureC', maximumChangePerMinute: null, stuckSeconds: 0, action: 'flag' },
          ])
        }
      >
        Legg til kvalitetsregel
      </button>
    </section>
  );
}
function TemplateEditor({ templates, set }) {
  return (
    <section>
      <h3>Egne eksportfiler</h3>
      {templates.map((template, index) => (
        <div className="settings-form" key={index}>
          <label>
            Filnavn
            <input
              required
              pattern="[a-z0-9](?:[a-z0-9]|_|-)*[.](?:txt|csv|html)"
              value={template.name}
              onChange={(e) =>
                set(templates.map((t, i) => (i === index ? { ...t, name: e.target.value } : t)))
              }
            />
          </label>
          <label>
            Innhold
            <textarea
              rows="4"
              value={template.content}
              onChange={(e) =>
                set(templates.map((t, i) => (i === index ? { ...t, content: e.target.value } : t)))
              }
            />
          </label>
          <button type="button" onClick={() => set(templates.filter((_, i) => i !== index))}>
            Fjern fil
          </button>
        </div>
      ))}
      <p className="muted small">
        Bruk for eksempel {'{{station.name}}'} og {'{{weather.temp}}'}. HTML-verdier escapes automatisk.
      </p>
      <button
        type="button"
        disabled={templates.length >= 12}
        onClick={() =>
          set([
            ...templates,
            {
              name: `weather-${templates.length + 1}.txt`,
              content: '{{station.name}}: {{weather.temp}} °C\n',
            },
          ])
        }
      >
        Legg til eksportfil
      </button>
    </section>
  );
}
function AlarmManager({ data, stations, operator, pending, configure, acknowledge }) {
  return (
    <>
      <section className="panel">
        <h2>Alarmregler</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Stasjon</th>
                <th>Regler</th>
                <th>Aktive</th>
                <th>Handling</th>
              </tr>
            </thead>
            <tbody>
              {data.configurations.map((record) => (
                <tr key={record.scope}>
                  <td>{stations.find((s) => s.value.id === record.value.stationId)?.value.name}</td>
                  <td>{record.value.rules.length}</td>
                  <td>
                    {data.states.filter((s) => s.station_id === record.value.stationId && s.active).length}
                  </td>
                  <td>{operator && <button onClick={() => configure(record)}>Endre alarmregler</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Alarmhistorikk</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tid</th>
                <th>Stasjon</th>
                <th>Alarm</th>
                <th>Hendelse</th>
                <th>Verdi</th>
                <th>Kvittering</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                <tr key={event.id}>
                  <td>{time(event.at)}</td>
                  <td>{stations.find((s) => s.value.id === event.station_id)?.value.name}</td>
                  <td>{event.name}</td>
                  <td>
                    {{
                      activated: 'Utløst',
                      cleared: 'Normalisert',
                      disabled: 'Deaktivert',
                      removed: 'Fjernet',
                    }[event.kind] || event.kind}
                  </td>
                  <td>{value(event.value)}</td>
                  <td>
                    {event.acknowledged_at ? (
                      time(event.acknowledged_at)
                    ) : operator ? (
                      <button disabled={pending} onClick={() => acknowledge(event.id)}>
                        Kvitter
                      </button>
                    ) : (
                      'Ikke kvittert'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.events.length && <p className="empty">Ingen alarmhendelser.</p>}
      </section>
    </>
  );
}
function AlarmForm({ record, pending, save }) {
  const [item, set] = useState(structuredClone(record.value));
  const change = (index, patch) =>
    set({ ...item, rules: item.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        save(item);
      }}
    >
      <h2 id="modal-title">Alarmregler</h2>
      {item.rules.map((rule, index) => (
        <fieldset key={rule.id}>
          <legend>{rule.name || 'Ny alarm'}</legend>
          <div className="form-grid">
            <Field label="Navn" name="name" item={rule} set={(updated) => change(index, updated)} required />
            <label>
              Måling
              <select value={rule.metric} onChange={(e) => change(index, { metric: e.target.value })}>
                {Object.entries(alarmMetrics).map(([key, label]) => (
                  <option value={key} key={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tilstand
              <select value={rule.comparison} onChange={(e) => change(index, { comparison: e.target.value })}>
                <option value="above">Over grensen</option>
                <option value="below">Under grensen</option>
                <option value="missing">Mangler verdi</option>
              </select>
            </label>
            {rule.comparison !== 'missing' && (
              <>
                <Field
                  label="Grenseverdi"
                  name="threshold"
                  type="number"
                  step="any"
                  item={rule}
                  set={(updated) => change(index, updated)}
                  required
                />
                <Field
                  label="Hysterese"
                  name="hysteresis"
                  type="number"
                  min="0"
                  step="any"
                  item={rule}
                  set={(updated) => change(index, updated)}
                  required
                />
              </>
            )}
            <Field
              label="Forsinkelse før alarm (sekunder)"
              name="delaySeconds"
              type="number"
              min="0"
              max="86400"
              item={rule}
              set={(updated) => change(index, updated)}
              required
            />
            <Field
              label="Forsinkelse før normalisering (sekunder)"
              name="clearDelaySeconds"
              type="number"
              min="0"
              max="86400"
              item={rule}
              set={(updated) => change(index, updated)}
              required
            />
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => change(index, { enabled: e.target.checked })}
            />
            Aktiv regel
          </label>
          <button
            type="button"
            onClick={() => set({ ...item, rules: item.rules.filter((_, i) => i !== index) })}
          >
            Fjern regel
          </button>
        </fieldset>
      ))}
      <div className="actions">
        <button
          type="button"
          disabled={item.rules.length >= 50}
          onClick={() =>
            set({
              ...item,
              rules: [
                ...item.rules,
                {
                  id: crypto.randomUUID(),
                  name: 'Ny alarm',
                  enabled: true,
                  metric: 'temperatureC',
                  comparison: 'below',
                  threshold: 0,
                  hysteresis: 1,
                  delaySeconds: 60,
                  clearDelaySeconds: 60,
                },
              ],
            })
          }
        >
          Legg til alarm
        </button>
        <button className="primary" disabled={pending}>
          Lagre som utkast
        </button>
      </div>
    </form>
  );
}
function HistoryImport({ api, onError }) {
  const [batch, setBatch] = useState(null),
    [preview, setPreview] = useState(null),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false);
  const run = async (apply) => {
    setBusy(true);
    try {
      const result = await api('/history-import', {
        ...batch,
        dryRun: !apply,
        ...(apply ? { previewId: preview.previewId } : {}),
      });
      if (apply) {
        setResult(result);
        setPreview(null);
      } else setPreview(result);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>Importer historikk</summary>
      <p>
        Velg en Weather Gateway-historikkpakke med UTC-tider. Forhåndsvisning utløper etter
        bekreftelsesfristen. Importen skriver til lokal historikk og aggregater.
      </p>
      <input
        type="file"
        accept=".json,application/json"
        disabled={busy}
        aria-label="Historikkpakke"
        onChange={async (e) => {
          try {
            const file = e.target.files?.[0];
            setBatch(file ? JSON.parse(await file.text()) : null);
            setPreview(null);
            setResult(null);
          } catch {
            onError('Historikkpakken må være gyldig JSON.');
          }
        }}
      />
      <div className="actions">
        <button disabled={!batch || busy} onClick={() => run(false)}>
          Forhåndsvis import
        </button>
        {preview && (
          <button className="primary" disabled={busy} onClick={() => run(true)}>
            Gjør import av {preview.records} målinger gjeldende
          </button>
        )}
      </div>
      {preview && (
        <p>
          {preview.records} målinger er validert. Frist: {time(preview.expiresAt)}.
        </p>
      )}
      {result && (
        <p role="status">
          Importert: {result.inserted}. Duplikater: {result.duplicates}. Feil: {result.failed.length}.
        </p>
      )}
    </details>
  );
}
function ClimateSummary({ climate }) {
  const fmt = (v, suffix) => value(typeof v === 'number' ? v.toFixed(2) : v, suffix);
  return (
    <div className="stats-grid">
      <Stat
        label="Middelvind"
        number={fmt(climate.means.windSpeedMs, ' m/s')}
        detail={`Datadekning ${((climate.coverage.windSpeedMs || 0) * 100).toFixed(1)} %`}
      />
      <Stat label="Vindrun" number={fmt(climate.windRunKm, ' km')} detail="Tidsintegrert vindhastighet" />
      <Stat
        label="Varmegraddager"
        number={fmt(climate.heatingDegreeDays, ' °C·d')}
        detail={climate.complete ? 'Avsluttet døgn' : 'Døgnet er ikke avsluttet'}
      />
      <Stat
        label="Referansefordampning"
        number={fmt(climate.referenceEtMm, ' mm')}
        detail={
          climate.referenceEtMissingInputs.length
            ? 'Nødvendige inngangsdata mangler'
            : 'FAO-56 Penman–Monteith'
        }
      />
    </div>
  );
}
function WeatherChart({ hourly }) {
  const [metric, setMetric] = useState('temperatureC');
  const good = hourly.filter((row) => typeof row[metric] === 'number');
  if (!hourly.length) return <p className="muted">Ingen gyldige målinger for grafen.</p>;
  const low = good.length ? Math.min(...good.map((r) => r[metric])) : 0,
    high = good.length ? Math.max(...good.map((r) => r[metric])) : 1,
    range = Math.max(1, high - low),
    begin = Date.parse(hourly[0].at),
    finish = Date.parse(hourly.at(-1).at),
    span = Math.max(3600000, finish - begin);
  const x = (r) => 50 + ((Date.parse(r.at) - begin) * 680) / span,
    y = (r) => 190 - ((r[metric] - low) * 150) / range;
  const paths = [];
  let path = '';
  for (const row of hourly) {
    if (typeof row[metric] !== 'number') {
      if (path) paths.push(path);
      path = '';
    } else path += `${path ? 'L' : 'M'}${x(row)},${y(row)} `;
  }
  if (path) paths.push(path);
  return (
    <section>
      <label>
        Graf
        <select aria-label="Graf" value={metric} onChange={(e) => setMetric(e.target.value)}>
          {[
            ['temperatureC', 'Temperatur (°C)'],
            ['humidityPct', 'Fuktighet (%)'],
            ['windSpeedMs', 'Vind (m/s)'],
            ['pressureHpa', 'Trykk (hPa)'],
          ].map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <svg viewBox="0 0 760 230" role="img" aria-label={`Historikk for ${metric}`}>
        <path d="M50 20V190H730" fill="none" stroke="currentColor" />
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#168e88" strokeWidth="2" />
        ))}
        {good.map((row) => (
          <circle key={row.at} cx={x(row)} cy={y(row)} r="3" fill="#168e88">
            <title>
              {time(row.at)}: {row[metric].toFixed(2)}
            </title>
          </circle>
        ))}
        <text x="5" y="40" fill="currentColor" fontSize="12">
          {(low + range).toFixed(1)}
        </text>
        <text x="5" y="190" fill="currentColor" fontSize="12">
          {low.toFixed(1)}
        </text>
        <text x="50" y="217" fill="currentColor" fontSize="12">
          {time(hourly[0].at)}
        </text>
        <text x="500" y="217" fill="currentColor" fontSize="12">
          {time(hourly.at(-1).at)}
        </text>
      </svg>
    </section>
  );
}
function Reports({ stations, api, onError, admin }) {
  const [station, setStation] = useState(stations[0]?.value.id || ''),
    [date, setDate] = useState(
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(new Date()),
    ),
    [mode, setMode] = useState('day'),
    [report, setReport] = useState(null),
    [busy, setBusy] = useState(false);
  return (
    <section className="panel settings-form">
      <h2>Rapporter og historikk</h2>
      {admin && <HistoryImport api={api} onError={onError} />}
      <form
        className="report-controls"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            setReport(
              await api(
                mode === 'records'
                  ? `/records/${station}`
                  : mode === 'day'
                    ? `/history/${station}/${date}`
                    : `/reports/${station}/${date.slice(0, mode === 'month' ? 7 : 4)}`,
              ),
            );
          } catch (e) {
            onError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Stasjon
          <select value={station} onChange={(e) => setStation(e.target.value)}>
            {stations.map((s) => (
              <option key={s.value.id} value={s.value.id}>
                {s.value.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Periode
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setReport(null);
            }}
          >
            <option value="day">Døgn</option>
            <option value="month">Måned</option>
            <option value="year">År</option>
            <option value="records">Alle rekorder</option>
          </select>
        </label>
        <label>
          Dato i perioden
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Henter …' : 'Vis rapport'}
        </button>
      </form>
      {report && (
        <>
          <button
            onClick={() =>
              download(
                `rapport-${report.stationId}-${report.date || report.period || 'rekorder'}.json`,
                report,
              )
            }
          >
            Last ned rapport
          </button>
          {report.period && (
            <a href={`/api/report-text/${report.stationId}/${report.period}`} download>
              Last ned tekstrapport
            </a>
          )}
          {report.hourly && <WeatherChart hourly={report.hourly} />}
          {report.metrics && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Måling</th>
                    <th>Laveste verdi</th>
                    <th>Tidspunkt</th>
                    <th>Høyeste verdi</th>
                    <th>Tidspunkt</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(report.metrics).map(([metric, record]) => (
                    <tr key={metric}>
                      <td>{alarmMetrics[metric] || metric}</td>
                      <td>{record.minimum.toFixed(2)}</td>
                      <td>{time(record.minAt)}</td>
                      <td>{record.maximum.toFixed(2)}</td>
                      <td>{time(record.maxAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.summary && (
            <>
              <div className="stats-grid">
                <Stat label="Gyldige målinger" number={report.summary.samples} detail={report.date} />
                <Stat
                  label="Laveste temperatur"
                  number={value(report.summary.temperatureC_MIN, ' °C')}
                  detail="Observerte data"
                />
                <Stat
                  label="Høyeste temperatur"
                  number={value(report.summary.temperatureC_MAX, ' °C')}
                  detail="Observerte data"
                />
              </div>
              {report.climate && <ClimateSummary climate={report.climate} />}
              {report.astronomy && (
                <p className="muted">
                  Soloppgang: {time(report.astronomy.sunrise)} · Solnedgang: {time(report.astronomy.sunset)}
                </p>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Målinger</th>
                      <th>Temperatur</th>
                      <th>Vind</th>
                      <th>Trykk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.hourly.map((h) => (
                      <tr key={h.at}>
                        <td>{time(h.at)}</td>
                        <td>{h.samples}</td>
                        <td>{value(h.temperatureC?.toFixed(1), ' °C')}</td>
                        <td>{value(h.windSpeedMs?.toFixed(1), ' m/s')}</td>
                        <td>{value(h.pressureHpa?.toFixed(1), ' hPa')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {report.days && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Dato</th>
                    <th>Min. temperatur</th>
                    <th>Maks. temperatur</th>
                    <th>Middeltemperatur</th>
                    <th>Nedbør</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(report.days).map(([date, day]) => (
                    <tr key={date}>
                      <td>{date}</td>
                      <td>{value(day.temperatureC?.min?.toFixed(1), ' °C')}</td>
                      <td>{value(day.temperatureC?.max?.toFixed(1), ' °C')}</td>
                      <td>{value(day.temperatureC?.mean?.toFixed(1), ' °C')}</td>
                      <td>{value(day.rainfallMm?.toFixed(1), ' mm')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
function Operations({ api, onError }) {
  const [health, setHealth] = useState(null),
    [backups, setBackups] = useState([]),
    [busy, setBusy] = useState(false);
  const reload = async () => {
    try {
      const [h, b] = await Promise.all([api('/health'), api('/backups')]);
      setHealth(h);
      setBackups(b);
    } catch (e) {
      onError(e.message);
    }
  };
  useEffect(() => {
    reload();
  }, []);
  return (
    <section className="panel settings-form">
      <div className="spread">
        <h2>Drift og sikkerhetskopier</h2>
        <button onClick={reload}>Oppdater</button>
      </div>
      {health && (
        <p>
          Database: {health.database} · Ledig disk: {(health.storage.availableBytes / 1024 ** 3).toFixed(1)}{' '}
          GiB ({health.storage.freePercent.toFixed(1)} %)
        </p>
      )}
      {health?.certificatesExpiring.length > 0 && (
        <p className="error">
          {health.certificatesExpiring.length} enhetssertifikater utløper innen 14 dager.
        </p>
      )}
      <p className="muted">
        Databasen kopieres konsistent mens tjenesten kjører. Nøkler og råfilarkiv må inngå i hostens separate
        sikkerhetskopi. Gjenoppretting utføres når tjenestene er stoppet.
      </p>
      <button
        className="primary"
        disabled={busy || backups.some((b) => b.state === 'running')}
        onClick={async () => {
          setBusy(true);
          try {
            await api('/backups', {});
            await reload();
          } catch (e) {
            onError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Opprett sikkerhetskopi
      </button>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Startet</th>
              <th>Status</th>
              <th>Identitet</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id}>
                <td>{time(b.startedAt)}</td>
                <td>{{ running: 'Kjører', complete: 'Fullført', failed: 'Feilet' }[b.state] || b.state}</td>
                <td className="monospace small">{b.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')).render(<App />);
