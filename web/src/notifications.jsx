import React, { useState } from 'react';
const names = {
  station_offline: 'Stasjon nede',
  esp_offline: 'Ingen kontakt med ESP32',
  data_age: 'Alder på værdata',
  sensor_contact_lost: 'Ingen ISS-data',
  heap_low: 'Lite minne på ESP32',
  spool_dropped: 'Tapte målinger i ESP-kø',
};
const emails = (s) =>
  s
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);
export function NotificationSettings({ data, stations, api, mode = 'smtp', onSaved, onConfigure }) {
  const [item, set] = useState(() => structuredClone(data?.settings.value)),
    [password, setPassword] = useState(''),
    [recipients, setRecipients] = useState(data?.settings.value.recipients.join(', ') || ''),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [newId, setNewId] = useState(null),
    [units, setUnits] = useState({});
  if (!item) return null;
  const smtp = (key, value) => set((old) => ({ ...old, smtp: { ...old.smtp, [key]: value } }));
  const rule = (id, patch) =>
    set((old) => ({ ...old, rules: old.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  const body = () => ({
    ...item,
    recipients: emails(recipients),
    smtp: { ...item.smtp, ...(password ? { password } : {}) },
  });
  async function run(fn) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel settings-form notification-settings">
      <div className="panel-heading">
        <div>
          <h2>{mode === 'smtp' ? 'E-post og SMTP' : 'E-postvarsler'}</h2>
          <p className="muted small">
            {mode === 'smtp'
              ? 'Tilkobling, kryptering og standardmottakere.'
              : 'Velg hendelser, stasjoner og tidsgrenser. Varsler sendes én gang og eventuelt med valgt gjentakelse.'}
          </p>
        </div>
        {mode === 'rules' && <button onClick={onConfigure}>SMTP-innstillinger</button>}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/notifications', { revision: data.settings.revision, value: body() });
            setPassword('');
            onSaved();
          });
        }}
      >
        {mode === 'smtp' ? (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={item.enabled}
                onChange={(e) => set({ ...item, enabled: e.target.checked })}
              />
              Aktiver e-postvarsling
            </label>
            <div className="form-grid">
              <label>
                SMTP-vert
                <input
                  required={item.enabled}
                  value={item.smtp.host}
                  onChange={(e) => smtp('host', e.target.value)}
                  placeholder="smtp.example.no"
                />
              </label>
              <label>
                SMTP-port
                <input
                  required
                  type="number"
                  min="1"
                  max="65535"
                  value={item.smtp.port}
                  onChange={(e) => smtp('port', Number(e.target.value))}
                />
              </label>
              <label>
                Sikkerhet
                <select value={item.smtp.security} onChange={(e) => smtp('security', e.target.value)}>
                  <option value="starttls">STARTTLS – påkrevd oppgradering</option>
                  <option value="tls">TLS fra tilkoblingsstart</option>
                  <option value="none">Uten TLS</option>
                </select>
              </label>
              <label>
                Avsenderadresse
                <input
                  type="email"
                  required={item.enabled}
                  value={item.smtp.from}
                  onChange={(e) => smtp('from', e.target.value)}
                  placeholder="weathergateway@example.no"
                />
              </label>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={item.smtp.authEnabled}
                onChange={(e) => smtp('authEnabled', e.target.checked)}
              />
              SMTP krever innlogging
            </label>
            {item.smtp.authEnabled && (
              <div className="form-grid">
                <label>
                  SMTP-brukernavn
                  <input
                    autoComplete="off"
                    value={item.smtp.user}
                    onChange={(e) => smtp('user', e.target.value)}
                    required
                  />
                </label>
                <label>
                  SMTP-passord
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      item.smtp.passwordSecret ? 'Tomt felt beholder lagret passord' : 'Angi passord'
                    }
                    required={!item.smtp.passwordSecret}
                  />
                </label>
              </div>
            )}
            <label>
              Standardmottakere
              <textarea
                rows="2"
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder="drift@example.no, vakt@example.no"
              />
            </label>
            {item.smtp.security !== 'none' && (
              <details>
                <summary>Egen CA for SMTP (valgfritt)</summary>
                <label>
                  CA-sertifikat i PEM
                  <textarea
                    rows="5"
                    value={item.smtp.caCertificate}
                    onChange={(e) => smtp('caCertificate', e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <p className="muted small">
                  Tomt felt bruker systemets betrodde CA-er. Sertifikatkontroll er alltid aktiv ved TLS.
                </p>
              </details>
            )}
            <div className="actions">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api('/notifications/test', { value: body(), send: false });
                    setMessage('SMTP-tilkoblingen er godkjent. Ingen e-post ble sendt.');
                  })
                }
              >
                Test SMTP
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api('/notifications/test', { value: body(), send: true });
                    setMessage('Testmelding er sendt til standardmottakerne.');
                  })
                }
              >
                Send testmelding
              </button>
            </div>
          </>
        ) : (
          <>
            {!item.enabled && (
              <p className="notice">
                E-postvarsling er deaktivert. Konfigurer og aktiver SMTP under Innstillinger.
              </p>
            )}
            {item.rules.map((r) => (
              <details className="notification-rule" key={r.id} open={r.id === newId}>
                <summary>
                  <span className={`status ${r.enabled ? 'green' : 'disabled'}`}>
                    <i />
                    {r.name}
                  </span>
                  <span className="muted small">
                    {names[r.kind]} ·{' '}
                    {r.stationIds.length ? `${r.stationIds.length} stasjoner` : 'Alle stasjoner'}
                  </span>
                </summary>
                <div className="form-grid">
                  <label>
                    Navn
                    <input value={r.name} required onChange={(e) => rule(r.id, { name: e.target.value })} />
                  </label>
                  <label>
                    Hendelse
                    <select value={r.kind} onChange={(e) => rule(r.id, { kind: e.target.value })}>
                      {Object.entries(names).map(([key, name]) => (
                        <option key={key} value={key}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {r.kind === 'heap_low' ? (
                    <label>
                      Varsle under ledig minne (byte)
                      <input
                        type="number"
                        min="1024"
                        value={r.minimumHeapBytes}
                        onChange={(e) => rule(r.id, { minimumHeapBytes: Number(e.target.value) })}
                      />
                    </label>
                  ) : (
                    r.kind !== 'spool_dropped' && (
                      <label>
                        Grense ({units[r.id] || 'sekunder'}; 0 bruker stasjonens røde grense)
                        <div className="inline-fields">
                          <input
                            type="number"
                            min="0"
                            step={units[r.id] === 'minutter' ? 'any' : '1'}
                            value={r.thresholdSeconds / (units[r.id] === 'minutter' ? 60 : 1)}
                            onChange={(e) =>
                              rule(r.id, {
                                thresholdSeconds: Math.round(
                                  Number(e.target.value) * (units[r.id] === 'minutter' ? 60 : 1),
                                ),
                              })
                            }
                          />
                          <select
                            aria-label={`Tidsenhet for ${r.name}`}
                            value={units[r.id] || 'sekunder'}
                            onChange={(e) => setUnits({ ...units, [r.id]: e.target.value })}
                          >
                            <option>sekunder</option>
                            <option>minutter</option>
                          </select>
                        </div>
                      </label>
                    )
                  )}
                  <label>
                    Gjenta etter (sekunder; 0 sender bare én gang)
                    <input
                      type="number"
                      min="0"
                      value={r.repeatSeconds}
                      onChange={(e) => rule(r.id, { repeatSeconds: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <div className="actions">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => rule(r.id, { enabled: e.target.checked })}
                    />
                    Aktiv
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={r.sendRecovery}
                      onChange={(e) => rule(r.id, { sendRecovery: e.target.checked })}
                    />
                    Send melding når kontakten er tilbake
                  </label>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={!r.stationIds.length}
                    onChange={(e) =>
                      rule(r.id, {
                        stationIds: e.target.checked ? [] : [stations[0]?.value.id].filter(Boolean),
                      })
                    }
                  />
                  Alle stasjoner
                </label>
                {!!r.stationIds.length && (
                  <div className="station-filters">
                    {stations
                      .filter((s) => s.value.model !== 'Netatmo')
                      .map((s) => (
                        <label className="checkbox" key={s.value.id}>
                          <input
                            type="checkbox"
                            checked={r.stationIds.includes(s.value.id)}
                            onChange={(e) =>
                              rule(r.id, {
                                stationIds: e.target.checked
                                  ? [...r.stationIds, s.value.id]
                                  : r.stationIds.filter((id) => id !== s.value.id),
                              })
                            }
                          />
                          {s.value.name}
                        </label>
                      ))}
                  </div>
                )}
                <label>
                  Egne mottakere (tomt bruker standardmottakere)
                  <input
                    value={r.recipients.join(', ')}
                    onChange={(e) => rule(r.id, { recipients: emails(e.target.value) })}
                  />
                </label>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => set({ ...item, rules: item.rules.filter((v) => v.id !== r.id) })}
                >
                  Fjern varselregel
                </button>
              </details>
            ))}
            {!item.rules.length && <p className="empty">Ingen e-postregler er opprettet.</p>}
            <button
              type="button"
              onClick={() => {
                const id = crypto.randomUUID();
                setNewId(id);
                set({
                  ...item,
                  rules: [
                    ...item.rules,
                    {
                      id,
                      name: 'Nytt varsel',
                      kind: 'data_age',
                      enabled: true,
                      stationIds: [],
                      thresholdSeconds: 30,
                      minimumHeapBytes: 32768,
                      repeatSeconds: 900,
                      sendRecovery: true,
                      recipients: [],
                    },
                  ],
                });
              }}
            >
              Legg til e-postregel
            </button>
          </>
        )}
        <div className="actions">
          <button className="primary" disabled={busy} type="submit">
            Lagre som utkast
          </button>
          <span className="muted small">
            Innstillingene lagres i weathergateway og tas i bruk etter test og bekreftelse.
          </span>
        </div>
      </form>
      {mode === 'rules' && !!data.events?.length && (
        <details>
          <summary>Siste e-postleveringer</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tid</th>
                  <th>Varsel</th>
                  <th>Levering</th>
                </tr>
              </thead>
              <tbody>
                {data.events.slice(0, 20).map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.created_at).toLocaleString('nb-NO')}</td>
                    <td>{e.payload.subject}</td>
                    <td>
                      {
                        {
                          sent: 'Sendt',
                          queued: 'I kø',
                          sending: 'Sender',
                          failed: 'Feilet',
                          cancelled: 'Avbrutt',
                        }[e.state]
                      }
                      {e.last_error && ` · ${e.last_error}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
