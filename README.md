# Weather Gateway

Node.js 24, Express 5 og React. Gateway for fire Davis-stasjoner med ESP-WROOM-32, kryptert MQTT, intern AD-administrasjon og kompatible data til Sunnmørsvær. Python brukes ikke i serveren.

Implementert: React-panel med sanntidsliste, stasjons- og enhetsadministrasjon, LDAPS og eksisterende AD-grupper, vedvarende test/bekreftelse/tilbakerulling, lokal tilbakeføring i ESP32-koden, sertifikatutstedelse og sperring, MQTT-inntak, direkte Davis ISS-mottak via RFM69HCW på 868 MHz, alternativ LOOP/LOOP2-dekoding, værindekser, historikk, døgn-/måneds-/årsaggregater, Socket.IO, fileksport, sikkerhetskopier og separate Docker/Portainer-stacker.

**Dette er ennå ikke godkjent for produksjon eller en fullstendig Weather Display-erstatning.** De konkrete funksjonshullene og verifikasjonskravene står i [leveransestatus](docs/release-status.md). AD-, Docker- og maskinvareverdier kan fylles inn senere. Manglende AD-oppsett gir ingen innlogging.

## Lokal utvikling

Bruk Node 24 LTS, og installer de låste avhengighetene:

```sh
npm ci
npm test
npm run build
```

Kopier [miljøeksemplet](.env.example) til `.env`, fyll inn LDAPS-verdiene og start `npm run dev:server`. `npm run dev` starter React på loopback. HTTP-unntaket er bare tillatt i utvikling på `127.0.0.1`; produksjon krever sikre HTTPS-cookies. Det finnes ingen standardbruker eller AD-omgåelse.

`.env` ligger i prosjektroten sammen med `package.json`. AD-bindpassordet kan skrives direkte som `WG_LDAP_PASSWORD='ditt_passord'`; en ikke-tom verdi har prioritet over `WG_LDAP_PASSWORD_FILE`. Start backend på nytt etter endringen.

## Docker og Portainer

[Driftsveiledningen](docs/deployment.md) beskriver bygg, `.env`, hemmelighetsfiler, klargjøring av disken, Portainer, sikkerhetskopi og gjenoppretting. Apache2-konfigurasjonen utføres senere, som avtalt.

[DockerHub-workflowen](.github/workflows/dockerhub.yml) bygger og publiserer **`janlon6260/weathergateway`** ved push til `main`, versjonstagger `v*.*.*` eller manuell kjøring. Den bruker GitHub-environment `prod` og secret `DOCKERHUB_TOKEN`. Workflow og Dockerfile kjører ingen tester. React og Express inngår i samme image, som gjenbrukes av de tre applikasjonstjenestene; Mosquitto har eget offisielt image.

| Miljø | Data på host | Intern adminport | Lokal API-port | MQTT/TLS |
| --- | --- | --- | --- | --- |
| Produksjon | `/data/req/weathergateway/production` | privat IP:18081 | 127.0.0.1:18080 | 8883 |
| Utvikling | `/data/req/weathergateway/development` | privat IP:18091 | 127.0.0.1:18090 | 8884 |

Hemmeligheter ligger under `/data/req/weathergateway/secrets/<miljø>`. Hver stasjon har `stations/<UUID>/raw`, `exports` og `reports`. Den offentlige tjenesten får bare en separat lesekopi av værdata; den får ikke kontrollbasen, AD-verdiene eller nøkler for enheter/CA.

Miljøknappen åpner den andre, selvstendige installasjonen. Utviklingsendringer skriver ikke til produksjon. Overføring oppretter produksjonsutkast som må testes og bekreftes. Nettverk, AD, nøkler, data og enhetstilkoblinger kopieres ikke mellom miljøene.

## Videre dokumentasjon

- [Arkitektur](docs/architecture.md), [sikkerhet](docs/security.md) og [MQTT/ESP32](docs/device-protocol.md).
- [Beregninger og kilder](docs/calculations.md), [Sunnmørsvær-kontrakt](docs/sunnmorsver-compatibility.md) og [Weather Display-matrisen](docs/weather-display-scope.md).
- [Firmwarebygg](firmware/README.md), [ISS-radio og koblingstabell](docs/davis-radio.md), [leveransestatus og testgrenser](docs/release-status.md).

Sunnmørsvær-prosjektet er lest lokalt og ikke endret. Den delte ChatGPT-lenken ga ikke tilgang til samtaleinnholdet.
