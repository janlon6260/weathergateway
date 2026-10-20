# Arkitektur

Backend er ESM JavaScript på Node 24/Express 5. Adminpanelet er React med Vite. SQLite i WAL-modus lagrer konfigurasjoner, revisjoner, endringer, sesjoner, kommandoer, råobservasjoner og aggregater. Synkrone transaksjoner gjør overgangene atomiske; langsomme nettverksoperasjoner utføres utenfor transaksjonen. SQLite er et enkeltstående hostoppsett; dette er ikke en HA-klynge.

Hvert miljø har fire containere:

| Tjeneste | Tilgang og ansvar                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------- |
| control  | Privat admin/API, LDAPS, endringsmotor, sertifikatutsteder. Eget nettverk.                                |
| worker   | MQTT-klient med eget klientsertifikat, validering, beregning, eksport, watchdog og offentlig datakopi.    |
| broker   | Mosquitto med TLS/mTLS og eksplisitte emnetilganger per sertifikat.                                       |
| public   | Egen HTTP/Socket.IO-applikasjon uten administrasjonsruter. Separat lesekopi av værdata og eget lesetoken. |

`public` får bare volumet `<miljø>/public` lesbart. Kopien inneholder stasjonsmetadata, siste observasjon, opptil tre timers trendmålinger, døgn-/timeaggregater og eksportfiler. AD, sesjoner, kommandoer, råpakker og CA-/enhetsnøkler kopieres ikke. Kopien oppdateres hvert andre sekund og kan regenereres fra hoveddatabasen. Ikke monter hovedvolumet i public-tjenesten.

Observasjoner identifiseres av `(stationId, bootId, sequence)`. MQTT-duplikater endrer ikke statistikken. Kildetid og mottakstid bevares hver for seg; sen ankomst erstatter ikke nyere sanntidsdata. Rå Davis-pakker med CRC bevares i hoveddatabasen og JSONL-arkivet. Beregnings- og kalibreringsversjon følger observasjonen.

Døgn bruker `Europe/Oslo`, timer lagres med UTC-identitet. Vår-/høstskiftet gir 23/25 timer uten å slå sammen de to like lokale klokkeslettene. Time- og døgnaggregater bevares når råmålingene utløper. Råfil og database er ikke én filsystemtransaksjon: databasen er autoritativ ved feil under JSONL-skriving.

## Endringsforløp

Ekstern MariaDB/MySQL-levering har en egen `database:<stasjons-UUID>`-konfigurasjon og administratorside. Inntaket oppretter leveringsrader i samme transaksjon som observasjonene. Worker bruker bare bekreftede databaseinnstillinger, sender fra varig kø og beholder køen ved feil. Tilkoblingstest er skrivebeskyttet. Miljøenes DB-mål er avgrenset med tillatelsesliste og et eget navnerom for utvikling. Se [leveringskontrakten](weather-database.md).

1. Et utkast inneholder gammel og foreslått verdi og forventet revisjon. Kun ett åpent utkast per område.
2. Testfunksjonen validerer skjema, lager og, for gatewayendringer, LDAPS samt at administratoren fortsatt har tilgang.
3. Testen aktiverer kandidaten med en vedvarende frist. Fristen bruker forrige bekreftede tidsinnstilling: 300 sekunder som standard, justerbar 30–3600 sekunder.
4. ESP-endringer sendes som `test_config`. Enheten lagrer kandidaten og fristen før omkobling. Gatewayen krever både kvittering og ferske sensordata med riktig konfigurasjonshash.
5. «Gjør gjeldende» krever fersk helsesjekk. Endret adminadresse må bekreftes fra den nye adressen. Kortere retensjon sletter ikke historikk før endringen er bekreftet. ESP-endringer er først bekreftet etter `commit_config` og faktisk kvittering fra enheten.
6. Utløp, kansellering eller feil ruller tilbake. To serverprosesser sjekker fristene; ESP32 har egen monoton frist og gjenoppretter bekreftet innstilling ved strømbrudd. Tilbakegående serverklokke avbryter aktive tester.

Ved nettverksbrudd under siste enhetskvittering kan server og enhet midlertidig ha ulik oppfatning av commit. Gatewayen sender rollback, og enhetens forrige bekreftede konfigurasjon bevares. Dette må prøves fysisk ved strømkutt og pakketap; en distribuert transaksjon kan ikke gis øyeblikkelig enighet gjennom en nettverkspartisjon.

HTTP-innstillinger som vertsnavn endrer applikasjonens policy. DNS, sertifikat for Apache, vertsbrannmur og Docker-portbindinger er infrastruktur og må endres koordinert utenfor panelet. Applikasjonen får ikke Docker-socket eller roottilgang til hosten.

## Miljøskille

Compose-filene har bokstavelige, forskjellige hostmapper og egne prosjektnavn, nettverk, porter og PKI. Både rotmarkør og database kontrollerer miljøet. Ingen «dev»-variabel omdirigerer et produksjonsvolum. Dette beskytter ikke mot en hostadministrator som bevisst monterer produksjonsdisken feil.

Overføringspakken inneholder driftsverdier og stasjonsdefinisjoner. Miljøspesifikke domener, AD, nøkler og enhetsnettverk overføres ikke. Import i produksjon lager utkast med normal test/bekreftelse. Fire fysiske enheter blir ikke automatisk et separat testlaboratorium: bruk utviklingsenheter eller simulator med utviklingssertifikater for full isolasjon.
