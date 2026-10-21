# Godkjent tredjepartstilgang til værdata

Administrer klienter under **Tilkoblinger**. Opprett én godkjenning per system, med navn, beskrivelse, alle eller utvalgte stasjoner, valgfri utløpsdato og grense for samtidige forbindelser. Evigvarende godkjenning betyr at det ikke er satt noen utløpsdato. Tilgang kan tilbakekalles, begrenses eller få en ny nøkkel når som helst.

Nøkkelen vises bare ved oppretting eller nøkkelbytte. Bare SHA-256-hashen lagres i MariaDB `weathergateway.api_clients`; plaintext-nøkkelen inngår ikke i audit, sikkerhetskopi eller offentlig policyfil. Oppbevar nøkkelen i tredjepartens backend. Alle endepunkter må nås via den offentlige HTTPS-adressen `https://wg-api.skrg.no`. Apache må støtte Socket.IO/WebSocket som før.

## Oppgradering av Sunnmørsvær

Et eksisterende `read-token` gir ikke lenger automatisk tilgang. Velg **Legg til tilkobling**, gi den navnet Sunnmørsvær og velg **Godkjenn eksisterende lesetoken for Sunnmørsvær**. Dette registrerer en eksplisitt godkjenning for det eksisterende tokenet, slik at backendens nøkkel kan beholdes. Velg riktige stasjoner og varighet før godkjenning. Alternativt kan en ny nøkkel opprettes og tas i bruk på Sunnmørsværs backend.

Eksisterende namespace `/` beholder `file-content`, `trend_snapshot`, `trend_update`, `get_trends`, `fetch24HourTrend`, `fetchTrendData` og `trendData`. Alle strømmer og historikkforespørsler filtreres etter godkjenningen. Den nye egenskapen `wind` i hver `file-content`-stasjon inneholder numeriske vind- og pilverdier; øvrige legacy-felt beholder typene sine. Weather Display-filene endres ikke.

## Nytt Socket.IO-grensesnitt

Namespace: **`/weather`**. Socket.IO-stien er fortsatt `/socket.io/`.

```js
import { io } from 'socket.io-client';

const socket = io('https://wg-api.skrg.no/weather', {
  transports: ['websocket'],
  auth: {
    token: process.env.WG_ACCESS_TOKEN,
    stations: ['Hahjem'], // Valgfritt; tom liste/utelatt gir alle godkjente stasjoner.
  },
});

socket.on('weather:snapshot', (packet) => {
  for (const station of packet.stations) {
    const { toDegrees, arrowRotationDegrees, beaufort } = station.wind;
    // Velg pilvariant med beaufort og roter nordvendt pil med arrowRotationDegrees.
    // toDegrees er retningen vinden blåser MOT, målt med klokken fra nord.
  }
});

socket.on('connect_error', (error) => console.error(error.message));
```

Stasjonsfilter godtar UUID, stasjonsnøkkel eller visningsnavn, med normalisering av bokstaver og Unicode. Tvetydige eller ikke-godkjente valg avvises. Uten filter sendes alle stasjoner som klienten har godkjenning for; det finnes ingen generell, anonym værstrøm.

`weather:snapshot` har `schema: "wg-weather-1"`, `environment`, `generatedAt` og `stations` som en liste. Hver stasjon inneholder `id`, `key`, `name`, `observedAt`, `receivedAt`, `sensorContact`, alle tilgjengelige `measurements`, `measurementTimes`, `derived`, `quality`, hele den eksisterende værrepresentasjonen i `weather`, samt `wind`:

```json
{
  "speedMs": 6,
  "fromDegrees": 270,
  "toDegrees": 90,
  "arrowRotationDegrees": 90,
  "fromCompass": "V",
  "toCompass": "Ø",
  "beaufort": 4,
  "beaufortBasis": "windSpeedMs"
}
```

Nordvendt SVG-pil roteres med klokken. Vind fra vest gir pil mot øst. Beaufort er klassifiseringen av den viste vindhastigheten i m/s; den er ikke merket som et ti-minutters middel. Ved stille vind (Beaufort 0) og manglende vindretning er `toDegrees` og `arrowRotationDegrees` null. Bevar nullverdier og kontroller måletid/kvalitet; ikke erstatt manglende målinger med 0. Skalaen følger [Met Office Beaufort-skala](https://weather.metoffice.gov.uk/guides/coast-and-sea/beaufort-scale).

Følgende forespørsler bruker Socket.IO acknowledgement med `{ok:true,data:...}` eller `{ok:false,error:...}`:

| Hendelse            | Forespørsel                               | Resultat                                     |
| ------------------- | ----------------------------------------- | -------------------------------------------- |
| `weather:get`       | `{stations: ["Hahjem"]}`                  | Ett øyeblikksbilde uten å endre abonnementet |
| `weather:subscribe` | `{stations: ["Hahjem", "Vatne"]}`         | Endrer abonnement og sender øyeblikksbilde   |
| `weather:history`   | `{station: "Hahjem", date: "2026-10-21"}` | Døgnets værhistorikk og aggregater           |

```js
const result = await socket.timeout(5000).emitWithAck('weather:subscribe', {
  stations: ['775147d2-71e6-480d-8827-392ace169301'],
});
```

Lese-HTTP-endepunktene bruker samme godkjenning: `Authorization: Bearer <nøkkel>`. `/weather/current?station=Hahjem` filtrerer eksisterende værrepresentasjon; `/files/:stationKey/:filename` begrenses til godkjente stasjoner. Admin-API og ESP32-kommandoer er aldri tilgjengelige med en leseklientnøkkel.

## Løpende autorisasjon og isolasjon

Tillatte nettsideopprinnelser angis som eksakte HTTPS-origins uten sti. Tom liste tillater server-til-server uten Origin-header. CORS er et tillegg; selve nøkkelen og stasjonsgodkjenningen kontrolleres alltid. Socket.IO-middleware kjøres bare én gang per tilkobling, så systemet kontrollerer i tillegg godkjenningen før hver forespørsel og hvert sekund mens strømmen er åpen. Se [Socket.IO middleware](https://socket.io/docs/v4/middlewares/) og [CORS](https://socket.io/docs/v4/handling-cors/).

Control publiserer en minimal, avledet policy i sertifikatmappens `roles/public/socket-clients.json`; denne er ikke det autoritative innstillingslageret. Public får bare nøkkelhasher, godkjente stasjons-ID-er, origins og tidsgrenser. Ingen SQL-, AD-, CA- eller enhetsprivatnøkler gis til public. Monteringen `roles/public:/run/credentials:ro` er uendret, og ekstra porter er ikke nødvendige.

Policyen fornyes av control hvert sekund og er gyldig i maksimalt 15 sekunder. Ved manglende policy, utløpt policy, stoppet kontrolltjeneste eller feil miljø avvises nye forespørsler og eksisterende forbindelser stenges. Tilbakekalling/nøkkelbytte gjelder ved neste kontroll, normalt innen ett sekund. Tidsbegrensede godkjenninger utløper også mens klienten allerede er tilkoblet. Denne kontrollen gjør at offentlig lesetilgang også stopper hvis kontrolltjenesten er utilgjengelig over policyfristen.
