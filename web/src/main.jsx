import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const labels = {
  overview: 'Oversikt',
  stations: 'Stasjoner',
  devices: 'Enheter',
  changes: 'Endringer',
  settings: 'Innstillinger',
  reports: 'Rapporter',
  audit: 'Hendelseslogg',
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
    [now, setNow] = useState(Date.now()),
    [filter, setFilter] = useState(''),
    [selection, setSelection] = useState([]),
    [audit, setAudit] = useState([]);
  const csrf = useRef('');
  const offset = useRef(0);
  async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`/api${path}`, {
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
  const visiblePages = Object.keys(labels)
    .filter((p) => !['settings', 'audit'].includes(p) || admin)
    .filter((p) => p !== 'devices' || operator);
  function scopeName(scope) {
    return scope === 'gateway'
      ? 'Gateway'
      : `${scope.startsWith('device:') ? 'Enhet' : 'Stasjon'} · ${data.stations.find((s) => scope.endsWith(s.value.id))?.value.name || scope}`;
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
          {visiblePages.map((p, index) => (
            <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>
              <span className="nav-icon">
                {['◈', '▤', '⌁', '↻', '⚙', '▥', '≡'][Object.keys(labels).indexOf(p)]}
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
              <p className="muted">
                {page === 'overview'
                  ? 'Status og siste målinger fra værstasjonene dine.'
                  : page === 'changes'
                    ? 'Test, kontroller og bekreft endringer før fristen løper ut.'
                    : page === 'settings'
                      ? 'Gateway, innlogging og miljøspesifikke innstillinger.'
                      : 'Administrer værstasjoner og tilhørende data.'}
              </p>
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
                  number={Object.values(live).filter((v) => v.status === 'green').length}
                  detail="Ferske og gyldige målinger"
                  tone="green"
                />
                <Stat
                  label="Trenger oppfølging"
                  number={Object.values(live).filter((v) => ['orange', 'red'].includes(v.status)).length}
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
                    <p className="muted small">Måletid og verdier fra stasjonens siste observasjon.</p>
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
                              <span
                                className={`status ${s.value.enabled ? l.status || 'unknown' : 'disabled'}`}
                              >
                                <i />
                                {!s.value.enabled
                                  ? 'Deaktivert'
                                  : { green: 'Tilkoblet', orange: 'Forsinket', red: 'Ingen ferske data' }[
                                      l.status
                                    ] || 'Venter på data'}
                              </span>
                            </td>
                            <td className="number">{value(l.temp, ' °C')}</td>
                            <td>{value(l.wlatest, ' m/s')}</td>
                            <td>{value(l.hum, ' %')}</td>
                            <td>{value(l.press, ' hPa')}</td>
                            <td>{value(l.rfall, ' mm')}</td>
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
          {page === 'devices' && (
            <>
              <div className="device-grid">
                {data.devices.map((device) => {
                  const station = data.stations.find((s) => s.value.id === device.value.stationId)?.value;
                  return (
                    <section className="panel device" key={device.scope}>
                      <div className="spread">
                        <span className="device-icon">⌁</span>
                        <span className={`status ${live[station?.key]?.status || 'unknown'}`}>
                          <i />
                          {live[station?.key]?.status === 'green' ? 'Tilkoblet' : 'Venter på data'}
                        </span>
                      </div>
                      <h2>{station?.name}</h2>
                      <p className="muted">
                        ESP-WROOM-32 ·{' '}
                        {device.value.interface === 'davis-iss-rfm69'
                          ? 'RFM69HCW · 868 MHz'
                          : 'Davis seriell'}
                      </p>
                      <dl>
                        <dt>Gateway</dt>
                        <dd>
                          {device.value.mqttHost}:{device.value.mqttPort}
                        </dd>
                        <dt>
                          {device.value.interface === 'davis-iss-rfm69' ? 'Kontaktmelding' : 'Måleintervall'}
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
                        <dt>Identitet</dt>
                        <dd className="monospace small">{device.value.stationId}</dd>
                      </dl>
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
                          <button
                            onClick={() =>
                              action(async () => {
                                const result = await api(`/devices/${station.id}/certificate`, {});
                                download(`esp32-${station.key}-credentials.json`, result);
                                setNotice(
                                  'Enhetspakken er lastet ned. Den inneholder en privatnøkkel og må oppbevares sikkert.',
                                );
                              })
                            }
                          >
                            Utsted sertifikat
                          </button>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
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
            </>
          )}
          {page === 'reports' && <Reports stations={data.stations} api={api} onError={setError} />}
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
function StationForm({ record, pending, save }) {
  const [item, set] = useState(
    record?.value || {
      name: '',
      key: '',
      model: 'Davis Vantage Pro2',
      enabled: true,
      latitude: 0,
      longitude: 0,
      elevationM: 0,
      exportName: 'station-wd.txt',
      rainCounterMmPerUnit: 0.2,
    },
  );
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
function DeviceForm({ record, pending, save }) {
  const [item, set] = useState(record.value);
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
  const [item, set] = useState(record.value),
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
          label="Varsle ved eldre data enn (sekunder)"
          name="warningSeconds"
          type="number"
          item={item}
          set={set}
        />
        <Field
          label="Marker utilgjengelig etter (sekunder)"
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
function Reports({ stations, api, onError }) {
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
      <form
        className="report-controls"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            setReport(
              await api(
                mode === 'day'
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
            <option value="year">år</option>
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
              download(`rapport-${report.stationId}-${report.date || report.period}.json`, report)
            }
          >
            Last ned rapport
          </button>
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
function Certificates({ api, stations, onError }) {
  const [certs, setCerts] = useState([]),
    [busy, setBusy] = useState(false);
  const reload = () =>
    api('/certificates')
      .then(setCerts)
      .catch((e) => onError(e.message));
  useEffect(() => {
    reload();
  }, []);
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Enhetssertifikater</h2>
        <button onClick={reload}>Oppdater</button>
      </div>
      <p className="muted small">
        Sperring av et sertifikat avslutter MQTT-forbindelsene slik at tilgangene kontrolleres på nytt.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Stasjon</th>
              <th>Utløper</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {certs.map((c) => (
              <tr key={c.id}>
                <td>{stations.find((s) => s.value.id === c.station_id)?.value.name || c.station_id}</td>
                <td>{time(c.expires_at)}</td>
                <td>{c.revoked_at ? 'Sperret' : Date.now() >= c.expires_at ? 'Utløpt' : 'Gyldig'}</td>
                <td>
                  {!c.revoked_at && (
                    <button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api(`/certificates/${c.id}/revoke`, {});
                          await reload();
                        } catch (e) {
                          onError(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Sperr
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!certs.length && <p className="empty">Ingen sertifikater er utstedt.</p>}
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
