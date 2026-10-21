# Weather Gateway

Node.js 24, Express 5 og React. Gateway for fire Davis-stasjoner med ESP-WROOM-32, kryptert MQTT, intern AD-administrasjon og kompatible data til Sunnmørsvær. Python brukes ikke i serveren.

Implementert: React-panel med sanntidsliste, LDAPS/roller, stasjons-/enhetsadministrasjon, test/bekreftelse/tilbakeføring, direkte Davis ISS/EU868, tidsvektet vind, vær-/klimaberegninger, rekorder, kalibrering, kvalitetsregler, alarmer, grafer, historikkimport, fil-/Socket.IO-kompatibilitet og SQL-kø til eksisterende databaser. ESP32 har varig sendekø, signert OTA og fjernfornyelse av klientsertifikat. Separate Docker/Portainer-stakker har automatisk databasebackup og produksjonskontroller.

**Implementasjonen er lokalt verifisert; produksjonsinstallasjon og fysisk maskinvare er ikke godkjent her.** Se [leveransestatus](docs/release-status.md) og [akseptanseprøvene](docs/production-acceptance.md). Identisk oppførsel for alle Weather Display-funksjoner må ikke antas. Manglende trykk gir manglende trykkavhengige beregninger, inkludert referanse-ET.

Vind vises med pil mot den retningen vinden blåser og Beaufort-tall etter pilen. [Socket.IO-grensesnittet](docs/socket-api.md) leverer alle tilgjengelige værfelt, numeriske vinddata og filtrering på navn/ID. Hvert tredjepartssystem må godkjennes under **Tilkoblinger**, med egen nøkkel, stasjonsvalg og tidsbegrenset eller evigvarende godkjenning. Ved oppgradering må eksisterende Sunnmørsvær-lesetoken også godkjennes her før det virker igjen.

**Kablet Vantage Pro2 ISS uten konsoll** støttes med 3,3 V MAX3485 og firmware 2.4.1: native 4800 baud / seksbytesdekoding, værdata, USB/OTA, helse og normal tilbakeføring. Protokollen har ingen kontrollsum på selve kabelen; dette vises som datakvalitet. ESP32–gateway bruker fortsatt mTLS. Se [protokollkilder, strømforsyning og bruk](docs/davis-rs485.md). Fysisk maskinvare er ikke testet her.

## Lokal utvikling

USB-flashing direkte i nettleseren og sanntidslogger via USB eller kryptert MQTT finnes under **Enheter**. Se [oppsett og bruk](docs/esp32-browser.md) for USB-pakker, nettleserkrav og firmware 2.1.0.

Bruk Node 24 LTS, og installer de låste avhengighetene:

```sh
npm ci
npm test
npm run build
```

Kopier [miljøeksemplet](.env.example) til `.env`, fyll inn LDAPS-verdiene og start `npm run dev:server`. `npm run dev` starter React på loopback. HTTP-unntaket er bare tillatt i utvikling på `127.0.0.1`; produksjon krever sikre HTTPS-cookies. Det finnes ingen standardbruker eller AD-omgåelse.

`.env` ligger i prosjektroten sammen med `package.json`. AD-bindpassordet kan skrives direkte som `WG_LDAP_PASSWORD='ditt_passord'`; en ikke-tom verdi har prioritet over `WG_LDAP_PASSWORD_FILE`. Start backend på nytt etter endringen.

Ekstern databaseskriving konfigureres under **Databaser** i adminpanelet, med passord og tillatte databasenavn i `.env`. Worker sender til eksisterende `wx_data` via en vedvarende kø. Se [databaseoppsett, feltkoblinger og overgang](docs/weather-database.md). Tilkoblingene er deaktivert som standard; utvikling kan bare bruke separate `wg_dev_`-databaser.

## Docker og Portainer

Firmware kompileres nå på serveren fra **Enheter → Bygg firmware på serveren**. Angi gatewayadresse, MQTT-port og Wi-Fi, og installer via nettleserens USB eller eksisterende MQTT/TLS med test/bekreft. [Byggtjenesten](docs/firmware-server-builds.md) bruker Espressifs offisielle ESP-IDF 6.1-image uten nettverk og med UID 70001/GID 70007. GitHub-workflowen publiserer bare app-imaget, med parallelle native bygg og uten tester.

[Driftsveiledningen](docs/deployment.md) beskriver bygg, `.env`, hemmelighetsfiler, klargjøring av disken, Portainer, sikkerhetskopi og gjenoppretting. Apache2-konfigurasjonen utføres senere, som avtalt.

[DockerHub-workflowen](.github/workflows/dockerhub.yml) bygger og publiserer **`janlon6260/weathergateway`** ved push til `main`, versjonstagger `v*.*.*` eller manuell kjøring. Den bruker GitHub-environment `prod` og secret `DOCKERHUB_TOKEN`. Workflow og Dockerfile kjører ingen tester. React og Express inngår i samme image, som gjenbrukes av de tre applikasjonstjenestene; Mosquitto har eget offisielt image.

| Miljø      | Data på host                           | Intern adminport | Lokal API-port  | MQTT/TLS |
| ---------- | -------------------------------------- | ---------------- | --------------- | -------- |
| Produksjon | `/data/req/weathergateway/production`  | privat IP:18081  | 127.0.0.1:18080 | 8883     |
| Utvikling  | `/data/req/weathergateway/development` | privat IP:18091  | 127.0.0.1:18090 | 8884     |

Hemmeligheter ligger under `/data/req/weathergateway/secrets/<miljø>`. Hver stasjon har `stations/<UUID>/raw`, `exports` og `reports`. Den offentlige tjenesten får bare en separat lesekopi av værdata; den får ikke kontrollbasen, AD-verdiene eller nøkler for enheter/CA.

Miljøknappen åpner den andre, selvstendige installasjonen. Utviklingsendringer skriver ikke til produksjon. Overføring oppretter produksjonsutkast som må testes og bekreftes. Nettverk, AD, nøkler, data og enhetstilkoblinger kopieres ikke mellom miljøene.

## Videre dokumentasjon

- [Arkitektur](docs/architecture.md), [sikkerhet](docs/security.md) og [MQTT/ESP32](docs/device-protocol.md).
- [Beregninger og kilder](docs/calculations.md), [Sunnmørsvær-kontrakt](docs/sunnmorsver-compatibility.md) og [Weather Display-matrisen](docs/weather-display-scope.md).
- [Firmwarebygg](firmware/README.md), [ISS-radio og koblingstabell](docs/davis-radio.md), [kablet ISS / MAX3485](docs/davis-rs485.md), [leveransestatus og testgrenser](docs/release-status.md).
- [Socket.IO, vindpiler og godkjente tredjepartstilkoblinger](docs/socket-api.md).
- [Signert OTA og sertifikatvedlikehold](docs/firmware-lifecycle.md), [produksjonsakseptanse](docs/production-acceptance.md).
- [Sertifikater fra adminpanelet og Docker-oppstart uten sertifikatfiler](docs/certificates.md).

Sunnmørsvær-prosjektet er lest lokalt og ikke endret. Den delte ChatGPT-lenken ga ikke tilgang til samtaleinnholdet.

Alle administrasjonsinnstillinger lagres nå i egen MariaDB-database `weathergateway` (utvikling: `weathergateway_development`). Sett `WG_CONFIG_DB_*` før oppstart. Se [oppgradering og nye funksjoner](docs/operations-20261021.md).
