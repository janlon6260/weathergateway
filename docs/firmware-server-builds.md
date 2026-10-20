# Firmwarebygg fra adminpanelet

Administrator åpner **Enheter → Bygg firmware på serveren**. Skjemaet velger gatewayens IP/DNS-navn, MQTT/TLS-port, SSID, Wi-Fi-passord, sertifikatvarighet og USB eller OTA. Serveren bygger unik firmware for valgt stasjon og miljø. Nettleseren viser fremdrift og bygglogg, henter USB-pakken direkte og kan starte en OTA-test. Ingen lokal ESP-IDF-installasjon eller filopplasting kreves i den normale flyten.

## Container og førstegangsoppsett

Workflowen publiserer appen som `janlon6260/weathergateway:latest` og byggtjenesten som `janlon6260/weathergateway:firmware-builder`, med tilhørende versjons- og commit-tagger. Den bruker samme `prod`/`DOCKERHUB_TOKEN` og kjører ingen tester. Deploy begge fra samme kildeversjon. ESP-IDF 6.1 er låst med manifest-digest i `builder/Dockerfile`, for amd64 og arm64. SDK og låste MQTT/cJSON-komponenter lastes inn ved Docker-bygg; kjøretidscontaineren bruker `network_mode: none`.

De eksisterende stackene og `scripts/render-compose.js` inkluderer `firmware-builder`. Alle tjenester bruker **UID 70001 / GID 70007**. Før en ny installasjon må hostens data- og sertifikatmapper være opprettet med dette eierskapet. Ved oppgradering må eksisterende mapper og filer også være tilgjengelige for denne brukeren; klargjøringstjenesten kjører uten root og endrer ikke vilkårlig eierskap.

Hvis en eksisterende Portainer-stack beholdes, legg til denne tjenesten (produksjon):

```yaml
  firmware-builder:
    image: janlon6260/weathergateway:firmware-builder
    user: "70001:70007"
    init: true
    restart: unless-stopped
    read_only: true
    network_mode: none
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    environment:
      WG_ENVIRONMENT: production
    volumes:
      - type: bind
        source: /data/req/weathergateway/production/system/firmware-builds
        target: /jobs
      - type: bind
        source: /data/req/weathergateway/production/system/firmware-build-cache
        target: /workspace
    tmpfs:
      - /tmp:rw,nosuid,size=256m
    mem_limit: 3g
    cpus: "2.0"
    pids_limit: 256
```

Opprett de to mount-mappene på hosten før deploy, med eier `70001:70007` og modus `700`. Kontrollserveren må se `/production/system/firmware-builds` som `/data/system/firmware-builds` gjennom sin eksisterende `/production:/data`-montering. Byggcontaineren trenger ingen porter, USB-enheter, nettverk, Docker-socket, AD-passord, SQL-tilgang, CA-privatnøkkel eller firmware-signeringens privatnøkkel. Avsett minst 3 GB RAM til byggtjenesten og flere GB disk til SDK-cache/bygg. Den første kompileringen tar lengre tid; senere bygg gjenbruker SDK-objekter.

Utvikling krever en egen builder med `WG_ENVIRONMENT: development` og bare `/development/...`-mapper. Produksjonsbyggeren avviser utviklingsjobber og omvendt. Bygg bruker kontrollserverens bekreftede konfigurasjon; produksjon endres ikke ved kompilering eller ved utviklingsbygg.

## Identiteter, passord og artefakter

- Enhetsidentitet og gjenbrukbart Wi-Fi-passord ligger kryptert med AES-256-GCM i `stations/<UUID>/firmware/identity.enc`, bundet til stasjon og miljø.
- Krypteringsnøkkelen `device-vault.key` ligger i kontrollserverens sertifikatmappe. Den må sikkerhetskopieres sammen med CA-/signeringsnøkler og de krypterte stasjonsfilene. Den kopieres ikke til broker, public, worker eller byggtjenesten.
- Ferdig USB-pakke og OTA-app ligger i `stations/<UUID>/firmware/`. Pakken inneholder innebygde enhetsopplysninger og skal behandles som en hemmelighet. Bare autentiserte administratorer kan hente den; offentlige ruter/Socket.IO eksponerer den ikke.
- Midlertidige jobber ligger i `system/firmware-builds`; separate SDK-/objektfiler i `system/firmware-build-cache`. Disse mappene må ha beskyttet tilgang: en kompilator må behandle enhetens privatnøkkel og Wi-Fi-verdier. De kan ikke deles med en annen, mindre betrodd byggtjeneste.
- Byggloggen begrenses og passord/privatnøkkel maskeres før kontrollserveren leser den. Passord lagres ikke i status, revisjonsloggen eller SQLite-byggmetadata.

En jobb er tidsbegrenset, bare én kompilering kjører per miljø, og kontrollserveren validerer stasjons-/miljøidentitet, bygg-UUID, sertifikat, konfigurasjon og segmenter før den signerer. Gamle bygg avvises dersom enhetsinnstillingene siden har blitt endret. Bruk et nytt bygg etter konfigurasjonsendringer. En importert eksisterende identitet må stemme med et gyldig, registrert sertifikat og privatnøkkelen.

## Fysisk verifisering

USB går via Web Serial på datamaskinen som har ESP32 koblet til. Serveren kompilerer, men kan ikke åpne en USB-port på en annen datamaskin uten nettleserens lokale tilgang. Bruk Chrome/Edge over HTTPS eller localhost. OTA krever at enheten allerede er provisjonert og koblet til MQTT. Ingen ny innkommende port åpnes på ESP32.

Serverbygg dekker foreløpig standardprofilen for ESP-WROOM-32/4 MB/RFM69HCW EU868. Den aktiverer ikke irreversible sikkerhets-eFuses. Pilotkort må fortsatt verifisere USB-flashing, ISS-mottak, MQTT, OTA-godkjenning, feil Wi-Fi/gateway og tilbakeføring. Lokale bygg- og nettlesertester erstatter ikke denne maskinvareprøven.

SDK-oppsettet følger [Espressifs dokumentasjon for ESP-IDF Docker](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32/api-guides/tools/idf-docker-image.html). Den lokale containerflyten legger til isolerte mapper, frakoblet kjøretid og kontrollserverens signering.
