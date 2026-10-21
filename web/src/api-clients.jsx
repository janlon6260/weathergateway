import React, { useState } from 'react';
const keys = [
  'name',
  'description',
  'enabled',
  'allStations',
  'stationIds',
  'expiresAt',
  'origins',
  'maxConnections',
];
const settings = (c) => Object.fromEntries(keys.map((k) => [k, c[k]]));
const localDate = (iso) => {
  const d = new Date(iso);
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const statuses = { approved: 'Godkjent', revoked: 'Tilbakekalt', expired: 'Utløpt' };
export function ApiClientAdministration({ clients, stations, api, onSaved }) {
  const [editor, setEditor] = useState(null),
    [expires, setExpires] = useState(''),
    [origins, setOrigins] = useState(''),
    [token, setToken] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [adopt, setAdopt] = useState(false);
  const open = (c) => {
    setError('');
    setAdopt(false);
    setEditor(
      c
        ? { id: c.id, revision: c.revision, value: settings(c) }
        : {
            value: {
              name: '',
              description: '',
              enabled: true,
              allStations: true,
              stationIds: [],
              expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
              origins: [],
              maxConnections: 3,
            },
          },
    );
    setExpires(localDate(c?.expiresAt || new Date(Date.now() + 30 * 86400000).toISOString()));
    setOrigins(c?.origins.join('\n') || '');
  };
  const change = (k, v) => setEditor((old) => ({ ...old, value: { ...old.value, [k]: v } }));
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="panel api-clients">
        <div className="panel-heading spread">
          <div>
            <h2>Godkjente datatilkoblinger</h2>
            <p>Én egen nøkkel per tredjepart, for Socket.IO og lese-API.</p>
          </div>
          <button className="primary" onClick={() => open(null)}>
            Legg til tilkobling
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {token && (
          <div className="notice access-token">
            <strong>Kopier nøkkelen nå – den vises bare én gang.</strong>
            <textarea aria-label="Ny tilgangsnøkkel" value={token} readOnly rows="2" />
            <div className="actions">
              <button onClick={() => run(() => navigator.clipboard.writeText(token))}>Kopier nøkkel</button>
              <button onClick={() => setToken(null)}>Jeg har lagret nøkkelen</button>
            </div>
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tilkobling</th>
                <th>Status</th>
                <th>Stasjoner</th>
                <th>Gyldig til</th>
                <th>Nøkkel</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                    <small>{c.description}</small>
                  </td>
                  <td>
                    <span
                      className={`status ${c.status === 'approved' ? 'green' : c.status === 'expired' ? 'orange' : 'red'}`}
                    >
                      <i />
                      {statuses[c.status]}
                    </span>
                  </td>
                  <td>
                    {c.allStations
                      ? 'Alle stasjoner'
                      : c.stationIds
                          .map((id) => stations.find((s) => s.value.id === id)?.value.name || id)
                          .join(', ')}
                  </td>
                  <td>{c.expiresAt ? new Date(c.expiresAt).toLocaleString('nb-NO') : 'Evigvarende'}</td>
                  <td>{c.tokenHint}</td>
                  <td>
                    <div className="actions">
                      <button onClick={() => open(c)}>Endre</button>
                      {c.enabled && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              api(
                                `/connections/${c.id}`,
                                { revision: c.revision, value: { ...settings(c), enabled: false } },
                                'PUT',
                              ),
                            )
                          }
                        >
                          Tilbakekall
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            const result = await api(`/connections/${c.id}/rotate`, { revision: c.revision });
                            setToken(result.token);
                          })
                        }
                      >
                        Lag ny nøkkel
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!clients.length && (
            <p className="empty">
              Ingen tredjeparter er godkjent. Opprett en tilkobling for Sunnmørsvær eller et annet system.
            </p>
          )}
        </div>
        <p className="muted small">
          Tilbakekalling og nøkkelbytte stopper eksisterende forbindelser. Nøkler gir bare tilgang til
          værdata.
        </p>
      </section>
      {editor && (
        <section className="panel settings-form">
          <h2>{editor.id ? 'Endre tilkobling' : 'Opprett og godkjenn tilkobling'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const value = {
                  ...editor.value,
                  expiresAt: editor.value.expiresAt ? new Date(expires).toISOString() : null,
                  origins: origins.split(/[\s,]+/).filter(Boolean),
                };
                if (editor.id)
                  await api(`/connections/${editor.id}`, { revision: editor.revision, value }, 'PUT');
                else {
                  const result = await api('/connections', { ...value, adoptLegacyToken: adopt });
                  setToken(result.token);
                }
                setEditor(null);
              });
            }}
          >
            <fieldset disabled={busy}>
              <div className="form-grid">
                <label>
                  Navn på tredjepart
                  <input
                    required
                    maxLength="100"
                    value={editor.value.name}
                    onChange={(e) => change('name', e.target.value)}
                    placeholder="Sunnmørsvær"
                  />
                </label>
                <label>
                  Maksimalt samtidige forbindelser
                  <input
                    type="number"
                    required
                    min="1"
                    max="20"
                    value={editor.value.maxConnections}
                    onChange={(e) => change('maxConnections', Number(e.target.value))}
                  />
                </label>
              </div>
              <label>
                Beskrivelse
                <textarea
                  maxLength="1000"
                  value={editor.value.description}
                  onChange={(e) => change('description', e.target.value)}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={editor.value.enabled}
                  onChange={(e) => change('enabled', e.target.checked)}
                />
                Godkjent og aktiv
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={editor.value.expiresAt === null}
                  onChange={(e) => {
                    const next = expires || localDate(new Date(Date.now() + 30 * 86400000).toISOString());
                    setExpires(next);
                    change('expiresAt', e.target.checked ? null : new Date(next).toISOString());
                  }}
                />
                Evigvarende godkjenning
              </label>
              {editor.value.expiresAt !== null && (
                <label>
                  Godkjenningen utløper
                  <input
                    type="datetime-local"
                    required
                    value={expires}
                    onChange={(e) => setExpires(e.target.value)}
                  />
                </label>
              )}
              <fieldset>
                <legend>Tilgang til stasjoner</legend>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={editor.value.allStations}
                    onChange={(e) => change('allStations', e.target.checked)}
                  />
                  Alle stasjoner, også nye som opprettes senere
                </label>
                {!editor.value.allStations && (
                  <div className="station-filter">
                    {stations.map(({ value: s }) => (
                      <label className="checkbox" key={s.id}>
                        <input
                          type="checkbox"
                          checked={editor.value.stationIds.includes(s.id)}
                          onChange={(e) =>
                            change(
                              'stationIds',
                              e.target.checked
                                ? [...editor.value.stationIds, s.id]
                                : editor.value.stationIds.filter((id) => id !== s.id),
                            )
                          }
                        />
                        {s.name}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <label>
                Tillatte nettsideopprinnelser, én per linje
                <textarea
                  value={origins}
                  onChange={(e) => setOrigins(e.target.value)}
                  placeholder="https://sunnmorsvaer.no"
                />
              </label>
              <p className="muted small">
                Tomt felt passer for server-til-server. Direkte nettlesertilgang krever eksakt
                HTTPS-opprinnelse. Oppbevar tilgangsnøkler i tredjepartens backend.
              </p>
              {!editor.id && (
                <label className="checkbox">
                  <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
                  Godkjenn eksisterende lesetoken for Sunnmørsvær
                </label>
              )}
              <p className="muted small">Endringen gjelder straks og kan tilbakekalles når som helst.</p>
              <div className="actions">
                <button className="primary" type="submit">
                  {editor.id ? 'Lagre godkjenning' : 'Opprett og godkjenn'}
                </button>
                <button type="button" onClick={() => setEditor(null)}>
                  Avbryt
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <section className="panel api-connection-help">
        <h2>Socket.IO</h2>
        <p>
          Namespace <code>/weather</code> på gatewayens offentlige API-adresse. Bruk <code>auth.token</code>{' '}
          og eventuelt <code>auth.stations</code> med stasjonsnavn, nøkkel eller ID. Data sendes som{' '}
          <code>weather:snapshot</code>.
        </p>
        <p className="muted small">
          Eksisterende <code>file-content</code> og trendhendelser er tilgjengelige i standardnamespace, med
          samme godkjenning og stasjonsbegrensninger.
        </p>
      </section>
    </>
  );
}
