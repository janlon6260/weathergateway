# Sikkerhet og verifikasjon

Undersøkt 19. oktober 2026. Implementerte kontroller er nedenfor; dette er ingen sikkerhetssertifisering eller ferdig ASVS-revisjon. Full produksjonsgodkjenning trenger testene i `release-status.md`.

## Nettverk og tilgang

Admin kjører på egen privat Docker-port og eget nettverk og krever privat klient-IP, AD-sesjon og rolle. Ingen offentlig admin-vhost/port skal opprettes. Docker publiserer normalt på alle grensesnitt uten eksplisitt adresse; stacken binder admin til valgt privat IP og offentlig HTTP-API til host-loopback for Apache. Test hostruting/brannmur for både IPv4 og IPv6. [Docker: publiserte porter](https://docs.docker.com/engine/network/port-publishing/).

Den offentlige Express-applikasjonen har bare leseendepunkter og Socket.IO. Den monterer en separat værdatakopi lesbart og har ingen AD-/CA-/enhetsnøkler eller kontrollbase. Sunnmørsværs backend bruker et tilfeldig lesetoken i Bearer-header/Socket.IO-auth; tokenet skal ikke sendes til nettleseren. Bytte av dette tokenet krever omstart av public-tjenesten, som også avslutter eksisterende socketforbindelser.

HTTP har rategrenser, JSON-størrelsesgrense og Helmet/CSP. Socket.IO har tokenkontroll, Origin-kontroll ved handshake, maksimal pakkestørrelse/antall forbindelser og begrensede lesehendelser. CORS er ikke autorisasjon. Ingen adminhendelser finnes i socketserveren. [Express: sikkerhet](https://expressjs.com/en/advanced/best-practice-security/), [Socket.IO: middleware](https://socket.io/docs/v4/middlewares/).

Origin og CSRF kreves på mutasjoner i admin, også korrekt Origin ved innlogging. Sesjoner har tilfeldig 256-bit token; bare hash lagres. Cookies er Secure/HttpOnly/SameSite=Strict med __Host-prefiks i produksjon. Inaktivitet og absolutt levetid håndheves; bakgrunnsoppdatering forlenger ikke inaktivitet. HTTP-cookieunntak krever utvikling og binding til 127.0.0.1.

## Windows AD / LDAPS

Klienten bruker simple bind over verifisert TLS, minst TLS 1.2, mot konfigurert FQDN. CA-kjede og servernavn valideres. Ingen automatisk nedgradering til LDAP eller `rejectUnauthorized:false`. Servicekontoen trenger bare nødvendige leserettigheter. Brukerpassord brukes til bind og lagres/logges ikke. Tomt passord avvises før bind. [Microsoft: LDAPS-sertifikater](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/configure-ldap-signing-certificates).

Eksisterende AD-grupper bindes til roller; medlemskap endres ikke. Nestede medlemskap bruker AD matching rule `1.2.840.113556.1.4.1941`. Gruppe-DN kan kombineres med forventet stabil SID. Kontroller at rollegruppene er ordinære sikkerhetsgrupper; medlemskap via `primaryGroupID` behandles ikke som denne søkeregelens medlemskap. LDAP-filterverdier escapes og søk avgrenses. Nettleseren kan ikke levere sine egne betrodde gruppelister.

Konto/SID og grupper verifiseres på nytt minst hvert minutt og før mutasjoner. Deaktivert konto, manglende rolle, feil SID og katalogfeil avviser tilgang. Kandidat til AD-oppsett prøves før aktivering og må bevare aktuell administrators rolle. Ved låst konfigurasjon trengs offline gjenoppretting; det finnes ingen lokal web-bakdør.

Dette er ikke SASL/Kerberos med LDAP channel binding. Microsoft skiller mellom simple bind over TLS og SASL med CBT; løsningen må prøves mot domenets faktiske policy uten å svekke denne. Dersom domenet krever en bindmekanisme som klienten ikke støtter, må klient/innloggingsarkitektur utvides. LDAPS alene gir ikke MFA. [Microsoft: LDAP channel binding](https://learn.microsoft.com/en-gb/windows-server/identity/ad-ds/ldap-channel-binding).

## MQTT og kommandoer

Broker er låst til Mosquitto 2.1.2. Kun TLS/mTLS-lytter, minst TLS 1.2; ingen offentlig 1883. Klientens sertifikat-CN brukes til eksplisitt ACL, ikke klientvalgt client-ID. Hver enhet har unik nøkkel og sertifikat. En enhet skriver bare egne telemetry/acks/status og leser egne commands. Arbeideren har separat sertifikat og kan lese målinger og skrive kommandoer; den har ikke CA-privatnøkkelen. [Mosquitto-konfigurasjon](https://mosquitto.org/man/mosquitto-conf-5.html).

Sertifikatsperring oppdaterer ACL og restarter broker for å avslutte eksisterende forbindelser. Dette gir et kort reconnect også for andre stasjoner og må prøves under last. Enhetssertifikat er klient-EKU, ikke server-EKU. Privat enhetsnøkkel leveres én gang over intern HTTPS og lagres ikke av serveren. Bootstrap-CA finnes bare i riktig miljøs hemmelighetsmappe.

Pakker, forbindelser og køer er begrenset. Inntaket har streng Zod-validering, kjent stasjon, tidsgrenser, identitetskontroll, per-stasjon rategrense og duplikatnøkkel. Kommandotypene er en fast liste, med ID, sekvens og TTL. Ingen retained-kommandoer, vilkårlig shell eller OTA-kodeutkjøring. Kritiske enhetshandlinger har lokal replaykontroll og vedvarende tilstand. [Espressif: ESP-MQTT](https://docs.espressif.com/projects/esp-mqtt/en/latest/esp32/).

Klientsertifikat fjernfornyes med samme nøkkel og prøves før gammel identitet sperres. OTA krever ECDSA P-256-signatur, stasjons-/miljøbinding, høyere sekvens, SHA-256 og eksplisitt administratorbekreftelse. Produksjonsprofil for Secure Boot V2 og flash-/NVS-kryptering er klargjort for verifisert ESP32 revision 3.0+. Den er ikke fysisk aktivert eller prøvd her. En referanse til TLS betyr ikke at lagrede nøkler dermed er fysisk beskyttet; førsteprovisjonering og eFuses må følge [firmwareveiledningen](../firmware/README.md).

## Drift

Normaldrift bruker egne UID-er, read-only containerrot, ingen capabilities og no-new-privileges. Ingen Docker-socket, privilegert container eller generell hostadministrasjon fra panelet. Hostmounts er separate, bokstavelige miljøstier. Hemmeligheter er filmontert per tjeneste. Logger utelater legitimasjon og fullstendige innkommende payloads; audit logger aktør, handling, identitet og hash.

Konfigurasjonsmutasjoner har utkast, revisjonskontroll, test, vedvarende tidsfrist og rollback. Sperring av kompromittert sertifikat og restart er eksplisitte operative handlinger, ikke reversible konfigurasjonsforsøk. Åpne tester må ikke brukes som en garanti for at ekstern DNS/Apache/hostendring automatisk kan rulles tilbake.

Databasen er autoritativ og backups er konsistente med SHA-256, automatisk plan og retensjon. Backup, diskkapasitet, sertifikatutløp, tidsynkronisering og restore må overvåkes på hosten. Backup- og auditdata inneholder identitetsinformasjon og må beskyttes. ESP32 har en avgrenset varig sendekø og frigjør data først etter gatewayens lagringskvittering. Full kø og langvarig database-/diskfeil kan fortsatt gi datatap; tap rapporteres eksplisitt.

OWASP ASVS 5.0.0 er relevant kontrollkatalog. Det er ikke gjennomført full sporbar ASVS-gjennomgang, penetrasjonstest, ekstern sikkerhetstest eller formell sikkerhetsgodkjenning. [OWASP ASVS](https://owasp.org/projects/asvs).
