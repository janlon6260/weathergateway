# Skriving til eksisterende værdatabaser

Gatewayens worker kan sende observasjoner direkte til Sunnmørsværs eksisterende MariaDB/MySQL-databaser, én tilkobling per stasjon. Tabellen heter `wx_data`. Det opprettes, endres eller slettes ingen eksterne tabeller automatisk. Netatmo beholdes i dagens løsning som avtalt.

## Oppsett

I prosjektrotens `.env`, eller riktig Portainer-stacks miljøvariabler:

```dotenv
WG_DB_ALLOWED_DATABASES=eksisterende_database_1,eksisterende_database_2
WG_DB_LAN_ENDPOINTS=172.29.50.40:3306
WG_DB_PASSWORD='passordet_til_skrivekontoen'
# Valgfritt, bare ved TLS mot en privat CA:
# WG_DB_CA_FILE=runtime/secrets/database-ca.pem
```

Bruk de faktiske databasenavnene; navnene over er plassholdere. På deres private lokalnett kreves verken TLS eller VPN mot SQL-serveren. Dersom TLS velges, bruker en tom `WG_DB_CA_FILE` Node sine vanlige betrodde CA-er. Privat CA angis som PEM-fil. I Docker monteres `secrets/<miljø>/db-ca.pem` bare i control og worker; en tom fil bruker standard CA-er i TLS-modus. Kjør host-bootstrap på nytt ved oppgradering slik at den nye filen opprettes. Eksisterende nøkler overskrives ikke.

Passordet sendes aldri til nettleseren eller lagres i konfigurasjon, audit eller leveringskø. Ulike skrivekontoer kan bruke `WG_DB_PASSWORD_SKODJE`, `WG_DB_PASSWORD_HAHJEM`, `WG_DB_PASSWORD_LONGVA` og `WG_DB_PASSWORD_VATNE`. Velg variabelnavnet i stasjonens databaseinnstillinger. Lokal kjøring støtter også andre variabler med prefikset `WG_DB_PASSWORD_`; ekstra variabler må videresendes eksplisitt i Docker-stacken. Start control og worker på nytt etter endring av miljøvariabler; Docker-containere må opprettes på nytt.

Åpne **Databaser → Konfigurer** som administrator. Sett vert, port, databasenavn, skrivebruker, stasjonsnavn i `station_id`, passordvariabel og eventuelle feltkoblinger. Standard lagringsintervall er 60 sekunder. Test tilkobling og skjema, lagre utkast, velg **Test endringen** og deretter **Gjør gjeldende** innen fristen. Ubekreftede databaseinnstillinger brukes bare til lesekontroll; leveringen fortsetter med tidligere bekreftede innstillinger. Tilbakeføring av innstillinger ruller ikke tilbake tidligere leverte værrader.

Skrivekontoen trenger lesetilgang til tabell og synlige skjemaopplysninger samt `INSERT` og `UPDATE` på `wx_data`. Den trenger ingen rettigheter til å endre eller slette tabeller. Tilkoblingstesten bruker bare SELECT og verifiserer ikke INSERT-/UPDATE-rettighetene med en faktisk skriving. Manglende skriverettigheter vises ved første levering; køen beholdes.

## Direkte SQL på privat lokalnett

Gatewayen og SQL-serveren står på samme private nett. **Privat lokalnett (uten TLS)** er standard under Databaser. Tilkoblingen går direkte til SQL-serveren og krever ingen kryptert tunnel. Eksakte endepunkter tillates separat i `.env`:

```dotenv
WG_DB_LAN_ENDPOINTS=172.29.50.40:3306
```

Endepunktet for deres eksisterende server er lagt inn i den lokale `.env`-filen. Portainer-miljøene har egne verdier. Både vert og port må matche; jokertegn tillates ikke. Bare private IPv4-adresser, IPv6 ULA og loopback godtas. DNS-resultatene for selve sokkelen kontrolleres, slik at en DNS-endring til offentlig adresse avvises før DB-autentisering. Samme database- og miljøavgrensning gjelder som ved TLS.

LAN-modus legger ikke til kryptering. **TLS med sertifikatkontroll** kan velges eksplisitt dersom databaseserveren tilbyr det; DB-CA-filen brukes bare da. Det finnes ingen automatisk overgang fra feilet TLS til LAN. Det tidligere konfigurasjonsnavnet `WG_DB_TUNNEL_ENDPOINTS` og transportverdien `vpn` godtas ved oppgradering som aliaser for LAN; den nye miljøvariabelen har prioritet også når den er tom. [mysql2: egen transport for pooler](https://sidorares.github.io/node-mysql2/docs/documentation/extras#connecting-using-custom-stream), [Node: socket-tilkobling og DNS-oppslag](https://nodejs.org/docs/latest-v24.x/api/net.html#socketconnectoptions-connectlistener).

Transportbytte krever vanlig utkast/test/bekreftelse og flytter ikke køen til et annet databasemål. Et nytt stasjonsnavnfelt, derimot, endrer payloaden og må konfigureres før levering aktiveres.

## Felt og kompatibilitet

Feltkoblingen er kartlagt fra Sunnmørsværs `weatherPersistence.js`, `settingsValidation.js` og `stationDatetime.js`. Runtime-konfigurasjonen kan ha andre kolonnenavn; kontroller disse i panelet før aktivering.

| Måling                  | Standardkolonne         |
| ----------------------- | ----------------------- |
| Temperatur              | `temperature`           |
| Luftfuktighet           | `outdoor_humidity`      |
| Lufttrykk               | `barometer`             |
| Regnintensitet          | `rain_rate`             |
| Døgnnedbør              | `daily_rainfall`        |
| Middelvind              | `average_windspeed`     |
| Vindkast                | `gust_windspeed`        |
| Vindretning             | `wind_direction`        |
| Døgnmaksimum temperatur | `max_daily_temperature` |
| Døgnmaksimum vindkast   | `max_gust_current_day`  |

Vind lagres som standard i km/t, som i eksisterende stasjonskonfigurasjon; m/s kan velges eksplisitt. Knappen **Bruk alle eksisterende værkolonner** kobler også duggpunkt, vindavkjøling, humidex, varmeindeks, tilhørende ekstremer, måneds-/års-/gårsdagens nedbør og én-times trykktrend. Vatne får i tillegg sol, jordtemperatur, værikon og lokale kalenderfelt. Feltkoblingene ligger i `shared/database-columns.js`.

Manglende sensorer blir `NULL`. Lufttrykk fra direkte ISS-mottak er derfor `NULL`, og ufullstendig regndøgn får ikke en oppdiktet døgnsum. Manglende jordtemperatur og værikon blir også NULL. Kalenderfeltene beregnes fra faktisk måletid. Heltallskolonner avrundes eksplisitt. En feltkobling med verdien `null` utelater kolonnen helt. Aktive målekolonner må være numeriske og tillate NULL, med unntak av garanterte kalenderfelt.

Vatnes eksisterende tabell krever også `station_name`. Sett **Kolonne for stasjonsnavn** til `station_name` for Vatne. Gatewayen skriver da stasjonens konfigurerte visningsnavn i feltet. For de øvrige tre tabellene kan feltet stå tomt. Kolonnen kan ikke kollidere med identitet, tid eller målekolonner.

`date` og `time` bevarer eksisterende `Europe/Oslo`-semantikk. Tabellen må ha en fullstendig unik nøkkel på `(date,time)` eller `(station_id,date,time)`. Andre unike nøkler godtas bare for automatisk generert ID. Manglende nøkkel eller inkompatible kolonner avviser testen; gatewayen utfører ingen skjemaendringer. Streng SQL-modus kreves for å unngå stille konvertering.

Det eksisterende skjemaet kan ikke skille to UTC-tidspunkter med samme lokale klokkeslett ved overgang til vintertid. Ved en slik nøkkelkollisjon beholdes første rad, og gatewayens lokale SQLite-historikk bevarer begge UTC-tidspunkter. Full UTC-identitet i ekstern DB krever en koordinert skjema- og leserendring i Sunnmørsvær.

## Levering og miljøskille

Observasjon og leveringsrad lagres i samme SQLite-transaksjon. Worker leverer radene i måletidsrekkefølge per stasjon. Ved feil beholdes køen med økende ventetid, opptil fem minutter mellom forsøk. Tidsavbrudd ødelegger SQL-forbindelsen før den kan gjenbrukes. Når en tilkobling er ubrukt, rydder poolen bort forbindelsene etter omtrent ett minutt.

Etter usikkert commit-resultat forsøkes raden på nytt. SQL bruker parameterverdier og `ON DUPLICATE KEY UPDATE station_id=station_id`: eksisterende værrader beholdes. Dette gir gjentakbar levering uten å overskrive nyere eller eksisterende historikk. Det er ikke en distribuert transaksjon mellom SQLite og MariaDB. [mysql2: pooler og parametere](https://sidorares.github.io/node-mysql2/docs), [MariaDB: duplikatnøkler](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/inserting-loading-data/insert-on-duplicate-key-update).

Køen kopieres med SQLite-backup og slettes ikke av rådataretensjon. Den må inngå i diskovervåkingen. Rader bindes til opprinnelig mål, stasjonsnavn, enheter og feltkobling. Ved endring av disse beholdes gamle rader som ventende for tidligere mål; de sendes aldri automatisk til en ny database. Lever køen før slike endringer, eller sett tilbake tidligere innstillinger for å levere den. Passordrotasjon, bytte av skrivekonto og endret intervall omdirigerer ikke køen.

Utvikling godtar bare databasenavn som starter med `wg_dev_`, i tillegg til den eksplisitte tillatelseslisten. Bruk testkopier av de eksisterende tabellene og en separat DB-konto som bare har rettigheter der. Produksjonsdatabaser skal aldri inn i utviklingskontoens rettigheter. Databaseinnstillinger overføres ikke med produksjonspromotering. Public-containeren får verken DB-legitimasjon, målinnstillinger, leveringsstatus eller kø.

Ved overgang skal én komponent eie skrivingen for hver stasjon: stans dagens Weather Display-/Sunnmørsvær-skriving for stasjonen før gatewayens produksjonsskriving aktiveres. En duplikatnøkkel alene samordner ikke to kilder med ulike måletider.

## Verifikasjon og nåværende begrensning

Lokale tester dekker transaksjonell kø, omstart, usikkert commit-resultat, beholdt historikk ved gjentakelse, enheter, NULL, rollegrenser, test/bekreftelse/tilbakeføring og skjerming av produksjonsmål. I tillegg starter `test/database-integration.test.js` en ekte, isolert MariaDB 11.4.13 på loopback når `WG_MARIADB_BIN` er satt. Den laster alle fire schema-fiksturene, prøver den faktiske migrasjonen og skriver alle felt med en begrenset testkonto. Testen omfatter faktisk commit etterfulgt av simulert tapt svar og trygg gjentakelse. Dette er gjennomført lokalt; det er ikke en produksjonsskrivetest.

Kontroll med TLS 19. oktober 2026 ga `HANDSHAKE_NO_SSL_SUPPORT`. Lesekontroll med direkte SQL uten TLS 20. oktober lyktes mot alle fire stasjonsdatabasene: standardkolonner, dato-/tidstyper, unik stasjons-/tidsnøkkel og streng SQL-modus ble verifisert. Brukeren har avklart at gatewayen og SQL-serveren er på samme private nett; VPN er ikke en forutsetning. Ingen produksjonsrader eller tabeller ble endret.

Den gjenstående skjemabegrensningen i produksjon er at målekolonnene er `NOT NULL`. Dette avviser blant annet manglende lufttrykk og kan gi falske nullmålinger i utelatte kolonner. [Migrasjonen](../deploy/sql/20261020-nullable-weather-measurements.sql) dekker alle eksisterende værmålekolonner i de fire tabellene og bevarer numeriske typer og nøkler. Den tillater NULL med NULL som standard. Den er prøvd mot isolerte skjemakopier; den er **ikke kjørt i produksjon**. Ta ordinær databasebackup og planlegg eventuell tabellås før kjøring med egnet driftskonto. Appen utfører ingen DDL automatisk. Schema-fiksturen er ikke en databackup. Produksjonsskriving og INSERT-/UPDATE-rettigheter må fortsatt verifiseres ved overgang.

Produksjonskontoen som var tilgjengelig for lesekontrollen hadde ikke DDL-rettigheter. Den ble ikke gitt utvidede rettigheter; migrasjonen og skrivetestene ble i stedet prøvd på den lokale, isolerte MariaDB-instansen.

## Historikkimport

Panelets **Rapporter → Importer historikk** tar `wg-history-1` med inntil 250 normaliserte telemetriobservasjoner per pakke og UTC-tider. Forhåndsvisning er knyttet til eksakt innhold, stasjon, innlogget aktør og bekreftelsesfrist. En brukt eller utløpt forhåndsvisning kan ikke gjenbrukes.

Større JSONL-filer kan importeres fra prosjektet på driftssiden:

```sh
node --env-file=.env scripts/import-history.js historikk.jsonl skodje --format=wx-data --wind-unit=kmh
node --env-file=.env scripts/import-history.js historikk.jsonl skodje --format=wx-data --wind-unit=kmh --apply
```

Første kommando er en tørrkjøring. `--apply` importerer i avgrensede grupper. Alternativt brukes `--format=telemetry` med full telemetrikontrakt eller UTC-måletid og målinger. For `wx-data` må vindenheten velges eksplisitt. Lokal Oslo-tid ved høstskiftet krever `--fold=earlier` eller `--fold=later`; vårskiftets ikke-eksisterende klokkeslett avvises. Del filer med ulike høsttimer i entydige deler, eller eksporter dem med kjent UTC-identitet. Stasjonsnøkkel kontrolleres mot eventuell `station_id` i kilderaden.

Importen bruker stabile duplikatidentiteter og bevarer kildeverdier uten å påføre dagens sensorkalibrering eller kvalitetsregler på nytt. Rå kilde/proveniens arkiveres ved CLI-import. Verken panelet eller CLI-importen oppretter leveringer til eksterne SQL-tabeller. Manglende historisk øyeblikksvind erstattes ikke med gjennomsnittsvind.
