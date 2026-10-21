# Firmwarebygg fra adminpanelet

Administrator åpner **Enheter → Bygg firmware på serveren**. Skjemaet velger gatewayens IP/DNS-navn, MQTT/TLS-port, SSID, Wi-Fi-passord, sertifikatvarighet og USB eller OTA. Serveren bygger unik firmware for valgt stasjon og miljø. Nettleseren viser fremdrift og bygglogg, henter USB-pakken direkte og kan starte en OTA-test. Ingen lokal ESP-IDF-installasjon eller filopplasting kreves i den normale flyten.

## Container og førstegangsoppsett

Workflowen publiserer bare app-imaget `janlon6260/weathergateway`, med parallelle native amd64/arm64-bygg og uten tester. Byggtjenesten bruker offisielt `espressif/idf:v6.1`, låst til manifest-digest i Compose. SDK-et publiseres ikke av denne workflowen. Prepare-tjenesten kopierer kildekode og kontrollerte MQTT/cJSON-komponenter fra app-imaget til den lesbare byggmalen; runtime bruker `network_mode: none`.

De eksisterende stackene og `scripts/render-compose.js` inkluderer `firmware-builder`. Alle tjenester bruker **UID 70001 / GID 70007**. Før en ny installasjon må hostens data- og sertifikatmapper være opprettet med dette eierskapet. Ved oppgradering må eksisterende mapper og filer også være tilgjengelige for denne brukeren; klargjøringstjenesten kjører uten root og endrer ikke vilkårlig eierskap.

Hvis en eksisterende Portainer-stack beholdes, legg til denne tjenesten (produksjon):

```yaml
  firmware-builder:
    image: espressif/idf:v6.1@sha256:81893c71bb5e570088901f21def8684c25cd2a9020281bd01b843a7655edb18c
    user: "70001:70007"
    init: true
    restart: unless-stopped
    read_only: true
    network_mode: none
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    command: [python, /opt/wg-builder/worker.py]
    environment:
      WG_ENVIRONMENT: production
      HOME: /tmp
      PYTHONUTF8: "1"
      IDF_COMPONENT_MANAGER: "0"
      IDF_PY_BUILD_JOBS: "2"
      CMAKE_BUILD_PARALLEL_LEVEL: "2"
    volumes:
      - type: bind
        source: /data/req/weathergateway/production/system/firmware-builds
        target: /jobs
      - type: bind
        source: /data/req/weathergateway/production/system/firmware-build-cache
        target: /workspace
      - type: bind
        source: /data/req/weathergateway/production/system/firmware-builder-runtime
        target: /opt/wg-builder
        read_only: true
    tmpfs:
      - /tmp:rw,nosuid,size=256m
    mem_limit: 3g
    cpus: "2.0"
    pids_limit: 256
```

Opprett alle tre mount-mappene på hosten før deploy, med eier `70001:70007` og modus `700` (byggmalen kan ha `750`). Kontrollserveren må se `/production/system/firmware-builds` som `/data/system/firmware-builds` gjennom sin eksisterende `/production:/data`-montering. Byggcontaineren trenger ingen porter, USB-enheter, nettverk, Docker-socket, AD-passord, SQL-tilgang, CA-privatnøkkel eller firmware-signeringens privatnøkkel. Avsett minst 3 GB RAM til byggtjenesten og flere GB disk til SDK-cache/bygg. Den første kompileringen tar lengre tid; senere bygg gjenbruker SDK-objekter.

Utvikling krever en egen builder med `WG_ENVIRONMENT: development` og bare `/development/...`-mapper. Produksjonsbyggeren avviser utviklingsjobber og omvendt. Bygg bruker kontrollserverens bekreftede konfigurasjon; produksjon endres ikke ved kompilering eller ved utviklingsbygg.

## Identiteter, passord og artefakter

- Enhetsidentitet og gjenbrukbart Wi-Fi-passord ligger kryptert med AES-256-GCM i `stations/<UUID>/firmware/identity.enc`, bundet til stasjon og miljø.
- Krypteringsnøkkelen `device-vault.key` ligger i kontrollserverens sertifikatmappe. Den må sikkerhetskopieres sammen med CA-/signeringsnøkler og de krypterte stasjonsfilene. Den kopieres ikke til broker, public, worker eller byggtjenesten.
- Ferdig USB-pakke og OTA-app ligger i `stations/<UUID>/firmware/`. Pakken inneholder innebygde enhetsopplysninger og skal behandles som en hemmelighet. Bare autentiserte administratorer kan hente den; offentlige ruter/Socket.IO eksponerer den ikke.
- Midlertidige jobber ligger i `system/firmware-builds`; separate SDK-/objektfiler i `system/firmware-build-cache`. Disse mappene må ha beskyttet tilgang: en kompilator må behandle enhetens privatnøkkel og Wi-Fi-verdier. De kan ikke deles med en annen, mindre betrodd byggtjeneste.
- Byggloggen begrenses og passord/privatnøkkel maskeres før kontrollserveren leser den. Passord lagres ikke i status, revisjonsloggen eller SQL-byggmetadata.

En jobb er tidsbegrenset, bare én kompilering kjører per miljø, og kontrollserveren validerer stasjons-/miljøidentitet, bygg-UUID, sertifikat, konfigurasjon og segmenter før den signerer. Gamle bygg avvises dersom enhetsinnstillingene siden har blitt endret. Bruk et nytt bygg etter konfigurasjonsendringer. En importert eksisterende identitet må stemme med et gyldig, registrert sertifikat og privatnøkkelen.

## Slette gamle bygg

Under **Enheter → Firmware og flashing** kan administrator velge **Slett bygg** og deretter **Slett bygg og filer**. Dette fjerner byggets jobbfiler, USB-pakke, OTA-bilde og bygglogg. **Eldre bygg** og **Nyere bygg** blar i historikken, 20 bygg per side. Henting av andre sider endrer ikke nettverksfeltene i byggskjemaet.

Pågående bygg, installert firmware og bygg som trengs av en aktiv test eller tilbakeføringskommando kan ikke slettes. Sist rapporterte build-ID fra ESP-en er også beskyttet. Avbrutte kompileringer må avsluttes før sletting; byggeren bekrefter dette med `finished.json` etter at underprosesser og midlertidige nøkler er ryddet. Ved oppgradering må **prepare kjøres fra nytt app-image og firmware-builder startes på nytt** for å laste denne protokollen.

Enhetsidentitet, bekreftede innstillinger og revisjonshistorikk beholdes. Minimal bygg-/utgivelsesmetadata beholdes i MariaDB slik at en slettet utgivelses sekvensnummer ikke gjenbrukes. Slettede bygg tilbys ikke for USB eller OTA. Den delte kompilatorcachen gjenbrukes av nye bygg og slettes ikke sammen med én jobb. Ved en filfeil vises bygget for nytt sletteforsøk, mens installasjon fra det blokkeres. Endepunktet `DELETE /api/firmware-builds/:id` krever administrator, intern tilgang og CSRF.

## Fysisk verifisering

USB går via Web Serial på datamaskinen som har ESP32 koblet til. Serveren kompilerer, men kan ikke åpne en USB-port på en annen datamaskin uten nettleserens lokale tilgang. Bruk Chrome/Edge over HTTPS eller localhost. OTA krever at enheten allerede er provisjonert og koblet til MQTT. Ingen ny innkommende port åpnes på ESP32.

Serverbygg dekker foreløpig standardprofilen for ESP-WROOM-32/4 MB/RFM69HCW EU868. Den aktiverer ikke irreversible sikkerhets-eFuses. Pilotkort må fortsatt verifisere USB-flashing, ISS-mottak, MQTT, OTA-godkjenning, feil Wi-Fi/gateway og tilbakeføring. Lokale bygg- og nettlesertester erstatter ikke denne maskinvareprøven.

SDK-oppsettet følger [Espressifs dokumentasjon for ESP-IDF Docker](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32/api-guides/tools/idf-docker-image.html). Den lokale containerflyten legger til isolerte mapper, frakoblet kjøretid og kontrollserverens signering.

Ved oppgradering må også prepare kjøre fra det nye app-imaget. Det gamle egendefinerte firmware-builder-imaget brukes ikke av de nye stackene.

## HTTP 500 / ER_NO_DEFAULT_FOR_FIELD ved byggstart

Eldre app-versjoner utelot `firmware_builds.log` ved oppretting av en jobb. MariaDB-tabellen kan ha dette som `LONGTEXT NOT NULL` uten standardverdi, slik at forespørselen feiler før kompilatoren starter. Rettelsen setter tom bygglogg eksplisitt og fungerer med den eksisterende tabellen. Ta i bruk det oppdaterte app-imaget og redeploy control-tjenesten; ingen manuell skjemaendring er nødvendig.

Regresjonstesten bruker det faktiske HTTP-endepunktet mot en isolert MariaDB med nettopp dette skjemaet, og kontrollerer `202 Accepted`, sentral lagring, loggoppdatering og kansellering.
