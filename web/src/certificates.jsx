import React, { useEffect, useState } from 'react';

const time = (value) => (value ? new Date(value).toLocaleString('nb-NO') : '–');
const download = (name, body) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const names = (text) =>
  text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
const validity = (form, prefix) => ({
  amount: Number(form.get(`${prefix}Amount`)),
  unit: form.get(`${prefix}Unit`),
});

function Validity({ prefix = 'validity', label = 'Gyldighet', amount = 1, unit: initialUnit = 'years' }) {
  const [unit, setUnit] = useState(initialUnit);
  return (
    <div className="form-grid">
      <label>
        {label}
        <input
          name={`${prefix}Amount`}
          aria-label={label}
          type="number"
          min="1"
          max={unit === 'years' ? 50 : 18262}
          defaultValue={amount}
          required
        />
      </label>
      <label>
        Enhet
        <select name={`${prefix}Unit`} value={unit} onChange={(e) => setUnit(e.target.value)}>
          <option value="years">År (inntil 50)</option>
          <option value="days">Døgn</option>
        </select>
      </label>
    </div>
  );
}

export function CertificateAdministration({ api, stations, onError }) {
  const [status, setStatus] = useState(null),
    [devices, setDevices] = useState([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [type, setType] = useState('server'),
    [now, setNow] = useState(Date.now());
  const reload = async () => {
    const [pki, certs] = await Promise.all([api('/pki'), api('/certificates')]);
    setStatus(pki);
    setDevices(certs);
  };
  useEffect(() => {
    let active = true;
    const load = () => reload().catch((e) => active && onError(e.message));
    load();
    const timer = setInterval(load, 3000),
      clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, []);
  async function action(fn) {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      await reload();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!status) return <section className="panel settings-form">Laster sertifikater …</section>;
  const ca = status.certificates.find((c) => c.type === 'ca'),
    incomplete =
      status.certificates.some((c) => ['ca', 'server', 'worker'].includes(c.type) && c.missing) ||
      !status.firmwareSigningReady ||
      !status.readTokenReady,
    pending = status.pending,
    serverType = ['server', 'https', 'database-server'].includes(type);
  return (
    <>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {incomplete && (
        <section className="panel settings-form">
          <h2>Førstegangsoppsett</h2>
          <p>
            Opprett CA, MQTT-server, gatewayens klientidentitet og firmware-nøkler. Eksisterende identiteter
            beholdes. MQTT starter når nødvendige sertifikater er klare.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              action(async () => {
                await api('/pki/initialize', {
                  caValidity: validity(form, 'ca'),
                  validity: validity(form, 'leaf'),
                  names: names(form.get('names')),
                });
                setNotice('Sertifikatene er opprettet. MQTT og gatewayens klient laster dem automatisk.');
              });
            }}
          >
            <Validity prefix="ca" label="CA-gyldighet" amount={50} />
            <Validity prefix="leaf" label="MQTT-sertifikatenes gyldighet" />
            <label>
              MQTT: DNS-navn og IP-adresser, adskilt med komma
              <input
                name="names"
                defaultValue={status.defaultNames?.join(', ') || 'wg-api.skrg.no, broker'}
                required
              />
            </label>
            <button className="primary" disabled={busy || !!pending}>
              Opprett manglende sertifikater og nøkler
            </button>
          </form>
        </section>
      )}
      {pending && (
        <section className="panel settings-form">
          <h2>{pending.state === 'draft' ? 'Sertifikatutkast' : 'Sertifikat under testing'}</h2>
          <p>
            {status.certificates.find((c) => c.type === pending.type)?.label} · Utløper{' '}
            {time(pending.certificate.expiresAt)}
          </p>
          <p className="monospace small">{pending.certificate.names || pending.certificate.subject}</p>
          {pending.state === 'testing' && (
            <p role="status">
              {Math.max(0, Math.ceil((pending.deadline - now) / 1000))} sekunder til automatisk
              tilbakerulling. Sertifikatkjede, nøkkel, gyldighet og bruksområde er kontrollert. Kontroller
              også forbindelsene før du bekrefter.
            </p>
          )}
          <div className="actions">
            {pending.state === 'draft' && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => action(() => api(`/pki/changes/${pending.id}/test`, {}))}
              >
                Test og aktiver midlertidig
              </button>
            )}
            {pending.state === 'testing' && (
              <button
                className="primary"
                disabled={busy || now >= pending.deadline}
                onClick={() => action(() => api(`/pki/changes/${pending.id}/confirm`, {}))}
              >
                Gjør gjeldende
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => action(() => api(`/pki/changes/${pending.id}/rollback`, {}))}
            >
              {pending.state === 'draft' ? 'Forkast utkast' : 'Gjenopprett forrige sertifikat'}
            </button>
          </div>
        </section>
      )}
      <section className="panel settings-form">
        <h2>Sertifikater og tillit</h2>
        <p>
          Dette miljøet har egen CA. Selvutstedte sertifikater kan ha inntil 50 års gyldighet. Enhets- og
          tjenestesertifikater begrenses av CA-ens utløpsdato. AD-sertifikater administreres separat.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Formål</th>
                <th>Navn / IP</th>
                <th>Utløper</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.certificates.map((c) => (
                <tr key={c.type}>
                  <td>{c.label}</td>
                  <td className="monospace small">{c.names || c.subject || '–'}</td>
                  <td>{time(c.expiresAt)}</td>
                  <td>
                    {c.missing ? 'Mangler' : c.invalid ? 'Ugyldig' : c.expiresAt <= now ? 'Utløpt' : 'Gyldig'}
                  </td>
                  <td>
                    {!c.missing && !c.invalid && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          action(async () =>
                            download(
                              `weathergateway-${status.environment}-${c.type}.json`,
                              await api(`/pki/export/${c.type}`, {}),
                            ),
                          )
                        }
                      >
                        {c.type === 'ca' ? 'Last ned CA og nøkkel' : 'Last ned sertifikat og nøkkel'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          HTTPS- og databasesertifikater lastes ned for installasjon på den aktuelle serveren. Offentlig
          betrodd HTTPS krever en offentlig CA og dennes gyldighetsgrenser. Nedlastinger med private nøkler må
          oppbevares beskyttet.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            action(() =>
              api('/pki/changes', {
                type,
                validity: validity(form, 'validity'),
                names: serverType ? names(form.get('names')) : [],
              }),
            );
          }}
        >
          <label>
            Generer eller forny
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {status.certificates.map((c) => (
                <option value={c.type} key={c.type}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <Validity />
          {serverType && (
            <label>
              DNS-navn og IP-adresser, adskilt med komma
              <input
                name="names"
                key={type}
                defaultValue={
                  type === 'server'
                    ? status.defaultNames?.join(', ')
                    : type === 'https'
                      ? status.adminName
                      : ''
                }
                required
              />
            </label>
          )}
          {type === 'ca' && (
            <p className="muted small">
              Fornyelse beholder CA-nøkkelen. Enheter som har en eldre CA-kopi, må få den fornyede CA-en før
              den gamle utløper.
            </p>
          )}
          <button className="primary" disabled={busy || !!pending || ca.missing}>
            Generer utkast
          </button>
        </form>
        <div className="actions">
          <button
            disabled={busy || !status.firmwarePrivateKeyAvailable}
            onClick={() =>
              action(async () =>
                download(
                  `firmware-signing-${status.environment}.json`,
                  await api('/pki/export/firmware', {}),
                ),
              )
            }
          >
            Last ned firmware-signaturnøkler
          </button>
          <button
            disabled={busy || !status.readTokenReady}
            onClick={() =>
              action(async () =>
                download(`read-token-${status.environment}.json`, await api('/pki/export/read-token', {})),
              )
            }
          >
            Last ned lesetoken
          </button>
        </div>
      </section>
      <section className="panel settings-form">
        <h2>ESP32-sertifikater</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget),
              stationId = form.get('station');
            action(async () => {
              const bundle = await api(`/devices/${stationId}/certificate`, {
                validity: validity(form, 'device'),
              });
              download(`esp32-${stationId}-credentials.json`, bundle);
              setNotice('Enhetspakken er lastet ned med sertifikat, privatnøkkel, CA og innstillinger.');
            });
          }}
        >
          <label>
            Stasjon
            <select name="station" required>
              {stations
                .filter((s) => s.value.enabled && s.value.model !== 'Netatmo')
                .map((s) => (
                  <option value={s.value.id} key={s.value.id}>
                    {s.value.name}
                  </option>
                ))}
            </select>
          </label>
          <Validity prefix="device" label="Enhetssertifikatets gyldighet" amount={90} unit="days" />
          <button className="primary" disabled={busy || ca.missing || !status.firmwareSigningReady}>
            Generer og last ned enhetspakke
          </button>
        </form>
        <p className="muted small">
          Hver enhet får en unik identitet. Sperring kobler fra MQTT-klienter slik at tilgangene kontrolleres
          på nytt.
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
              {devices.map((c) => (
                <tr key={c.id}>
                  <td>{stations.find((s) => s.value.id === c.station_id)?.value.name || c.station_id}</td>
                  <td>{time(c.expires_at)}</td>
                  <td>{c.revoked_at ? 'Sperret' : c.expires_at <= now ? 'Utløpt' : 'Gyldig'}</td>
                  <td>
                    {!c.revoked_at && (
                      <button
                        disabled={busy}
                        onClick={() => action(() => api(`/certificates/${c.id}/revoke`, {}))}
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
        {!devices.length && <p className="empty">Ingen enhetssertifikater er utstedt.</p>}
      </section>
    </>
  );
}
