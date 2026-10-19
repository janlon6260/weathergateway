# Kompatibilitet med Sunnmørsvær

Kartlagt 19. oktober 2026 ved lesing av eksisterende lokal kildekode. Kilde: `C:/Users/janlon.SKRG/.vscode/weather-app/weather-app`, Git HEAD `7f88a71fd95bc86a4098a289d5bbd926388802b8`, ren arbeidsmappe ved lesing. Ingen filer der ble endret. Dette dokumenterer kildekodens kontrakt; det er ikke bevis på at samme versjon er deployet i produksjon.

## Stasjonsnøkler og filer

`weather-api/src/config/stations.js` definerer følgende standarder. Administrasjonen på værsiden kan overstyre konfigurasjonen, så faktisk runtime-konfigurasjon må kontrolleres ved integrasjon.

| Publiseringsnøkkel | Modell fra kildekoden | Eksisterende data-URL |
| --- | --- | --- |
| `Skodje` | Davis Vantage Vue | `https://data.sunnmorsver.no/skodje/upload/skodje-wd.txt` |
| `Hahjem` | Davis Vantage Pro2 | `https://data.sunnmorsver.no/hahjem/upload/hahjem-wd.txt` |
| `Longva` | Davis Vantage Vue | `https://data.sunnmorsver.no/flemsoy/upload/flemsoy-wd.txt` |
| `Vatne` | Davis Vantage Pro2 | `https://data.sunnmorsver.no/vatne/upload/vatne-wd.txt` |
| `Tossa` | Netatmo | Separat `/netatmo`-strøm; integrasjon utsatt |

`Longva` og filstien `flemsoy` er med hensikt ulike. Interne UUID-er i gatewayen må ha en eksplisitt mapping til disse nøklene. Filnavnene kan ikke erstattes med `clientraw.txt` uten kompatibilitetsarbeid.

`weather-api/src/services/fetchData.js` forventer at Axios gir et JSON-objekt fra disse `.txt`-adressene. Data trimmes, enkelte felt kan mappes, og resultatet sendes videre på socket. Direkte innhenting av filene med nettlesetjenesten lyktes ikke i denne økten. Faktisk filinnhold, Content-Type, tegnsett, alle numeriske datatyper og avrunding er derfor ikke verifisert mot live.

## Hendelser

| Hendelse | Retning | Form observert i kildekoden |
| --- | --- | --- |
| `file-content` | Server → klient | Objekt med stasjonsnøkler. Fullt øyeblikksbilde ved tilkobling; deloppdateringer med én/flere stasjoner senere. |
| `get_trends` | Klient → server | Forespørsel om gjeldende trendcache. |
| `trend_snapshot` | Server → klient | `{ [stationKey]: { [measurementType]: trend } }` |
| `trend_update` | Server → klient | `{ station, type, trend }`, med `up`, `down` eller `flat` |
| `fetch24HourTrend` | Klient → server | `{ station, type }` |
| `trendData` | Server → klient | Normalt `{ station, type, data }`; historikksøk har også summer/ekstremer. Feil er objekt med `error`. |
| `fetchTrendData` | Klient → server | `{ station, date }` |
| `update` i `/netatmo` | Server → klient | Netatmo-kontrakt; beholdes på eksisterende side inntil egen migrering. |

Andre eksisterende hendelser som `site-config`, `text-forecast` og `yr-comparison` tilhører værsidens konfigurasjon/prognosetjenester. Gatewayen skal ikke tilfeldig overta disse. Migreringsdesignet må skille observasjonsmating til Sunnmørsværs backend fra å erstatte hele det eksisterende API-et.

Gatewayen produserer nå JSON i de kjente filnavnene og tilbyr de observerte vær-/trendhendelsene via Socket.IO. `integrations/sunnmorsver.js` er en serveradapter for `file-content`; den er ikke koblet inn i nettstedet. Nettstedets prognoser, site-config og Netatmo beholdes i eksisterende backend. Ingen endringer er utført i værsidens repo. Gatewayens endepunkter er `/files/<stationKey>/<filename>` og krever lesetoken. De gamle offentlige URL-ene videreføres først når Apache/innhenting er konfigurert og testet.

## Målefelt og semantikk

Fra `weather-client/src/lib/objects/weather-data.js`, `services/fetchData.js`, `services/stationHealth.js` og `services/weatherPersistence.js`:

| Gruppe | Felter som må undersøkes/bevares |
| --- | --- |
| Temperatur | `temp`, `tempTL`, `tempTH`, `intemp`, `TtempTL`, `TtempTH` |
| Fukt | `hum`, `humTL`, `humTH`, `inhum`, `inhumTL`, `inhumTH` og respektive tidsfelt |
| Avledet | `dew`, `dewpointTL`, `dewpointTH`, `apptemp`, `apptempTL`, `apptempTH`, `wchill`, `wchillTL`, `heatindex`, `heatindexTH`, `humidex` og respektive tidsfelt |
| Vind | `wlatest`, `wspeed`, `wgust`, `wgustTM`, `TwgustTM`, `windTM`, `bearing`, `avgbearing`, `bearingTM`, `BearingRangeFrom10`, `BearingRangeTo10`, `WindRoseData`, `domwinddir`, `windrun`, `beaufort`, `Tbeaufort` |
| Trykk | `press`, `pressTL`, `pressTH`, `pressL`, `pressH`, `TpressTL`, `TpressTH`, `presstrendval` |
| Nedbør | `rfall`, `rrate`, `rrateTM`, `TrrateTM`, `hourlyrainTH`, `ThourlyrainTH`, `LastRainTipISO` |
| Stråling | `UV`, `UVTH`, `SolarRad`, `CurrentSolarMax`, `SolarTM` |
| Øvrig | `cloudbasevalue`, `cloudbaseunit`, `forecast`, `temptrend`, `version`, `build`, `ver` |
| Tid/enheter | `date`, `dateFormat`, `timeUTC`, `tempunit`, `windunit`, `pressunit`, `rainunit` |

Kritiske regler fra konsumentkoden:

- `timeUTC` er en kommaseparert UTC-kalenderverdi, `YYYY,M,D,H,m[,s]`. Bare klokkeslett i `date` er ikke tilstrekkelig til å godkjenne en observasjon.
- Fremtidig observasjonstid over ett minutt avvises i eksisterende kildekode. Ferskhet vurderes ut fra måletid, ikke når en fil lastes ned.
- `SensorContactLost` lik `1` gjør en observasjon ugyldig. Status og kvalitet kan ikke utledes av at MQTT-forbindelsen lever alene.
- `wlatest` er øyeblikksvind, mens `wspeed` er middelvind. Værsidens innhenter har en reserveverdi, men registrerer også `instantWindAvailable`; kartet skal ikke fremstille middelvind som en faktisk øyeblikksmåling.
- Observasjonsvind på klientsiden er i m/s. Deler av historikk-/persistensadapteren bruker km/t basert på stasjonskonfigurasjon. Ingen felles, blind omregning må innføres.
- `wgustTM` og `tempTH` brukes til døgnmaksima i historikk. Manglende kildeverdier må ikke bli til null.
- `status`, `state`, `thresholds`, `lastValidTime`, `lastHeartbeatTime` og `lastInvalidTime` er serverstyrte felt. Eksisterende innhenter filtrerer dem bort fra værfilen. Gatewayens kvalitetsmodell må oversettes bevisst dersom den mates direkte inn.
- `file-content` kan være en deloppdatering; konsumenter slår sammen per stasjon.

## Implementert kontrakt og gjenværende verifikasjon

Socket.IO testes med faktisk server/klient. Vind er m/s, tidspunkter er ISO/UTC i trendserier. Døgnresponsen beholder lokal timestamp og gir i tillegg UTC-identitet for gjentatt høsttime. Legacy-felt som ennå ikke er beregnet er tomme strenger/array, ikke fiktive nullverdier. Dermed er formen forberedt, men full feltparitet er fortsatt ikke oppnådd.

## Påkrevde kontrakttester før overgang

1. Fang sanerte, representative faktiske filer og socketmeldinger som fixtures, med kildeversjon og enhetsangivelser.
2. Test alle fire publiseringsnøkler og filstier med eksisterende parser og frontendhjelpere.
3. Test tomme verdier, null, vindstille, sensorbortfall, forsinkede/dupliserte målinger, døgnskifte og sommer-/vintertid.
4. Test at et forsinket HTTP-svar ikke overskriver nyere socketdata.
5. Sammenlign historikk, døgnmaksima og enheter før og etter overgang, uten å skrive til produksjonsdatabasen i utvikling.
6. Avklar skjema, format og kilder for alle ekstra rapport-/Weather Display-filer. De kjente `*-wd.txt`-filene er ikke automatisk en full filinventarliste.
