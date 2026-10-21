# Leveransestatus – 21. oktober 2026

React, Node/Express, Docker-oppsett og ESP-IDF-firmware er implementert i dette prosjektet. Denne leveransen er lokalt verifisert; den er **ikke produksjonsgodkjent på deres utstyr**. Ingen Docker-host eller fysisk ESP32 er tilgjengelig i denne økten. Det er ikke utført flashing, eFuse-endring, produksjons-DDL eller produksjonsskriving.

## Implementert

- Intern AD/LDAPS-innlogging, eksisterende grupper til roller, sesjoner, CSRF, revisjonskontroll og audit. Brukeren har bekreftet fungerende AD-innlogging.
- React-panel med en/flere/alle stasjoner, sanntidsdata, historikkgrafer, rekorder, kalibrering, kvalitetsregler, alarmregler og alarmhistorikk.
- Separate utviklings-/produksjonsstakker og data. Miljøbytte og eksplisitt overføring til produksjonsutkast. Ubekreftede innstillinger brukes ikke av SQL-levering, kalibrering, alarmregler eller backupplan.
- Vedvarende test/bekreftelse/tilbakeføring, som standard 300 sekunder, inkludert lokal ESP32-frist og uavhengig konfigurasjonsvakt.
- Direkte Davis ISS-mottak via RFM69HCW/EU868, alternativ LOOP/LOOP2, CRC, sender-ID, feltvise måletider, duplikater og manglende sensorer. Lufttrykk er etter avtale manglende.
- Værindekser, tidsvektet middelvind og retning, vindrun/vindrose, regnperioder, graddager, FAO-56 referanse-ET, astronomi og solstrålingsestimat. Se [metoder og nødvendige innganger](calculations.md).
- Eksisterende Sunnmørsvær-filer og Socket.IO-hendelser, atomiske egendefinerte tekst-/CSV-/HTML-maler, klimautdata og sporbar historikkimport med forhåndsvisning.
- Vindpil mot vindens bevegelsesretning og Beaufort-tall etter pilen, med samme numeriske metadata i Socket.IO. Namespace `/weather` gir alle tilgjengelige værfelt, filtrering på navn/ID og historikk. Hvert system godkjennes av administrator under **Tilkoblinger**, med stasjonsvalg, egen nøkkel og valgfri utløpstid. Åpne forbindelser frakobles ved utløp, tilbakekalling eller nøkkelbytte. Godkjenningene lagres i MariaDB `weathergateway`; public får bare en avledet policy med maksimalt 15 sekunders gyldighet. Se [API og oppgradering av eksisterende lesetoken](socket-api.md).
- MAX3485-profil for direkte kablet Vantage Pro2 ISS uten konsoll: serverbygg, signert USB-pakke, valgbare pinner/baudrate, mottaksopptak og helseverdier. **Dette er diagnostikk; direkte ISS-værdekoding er ikke ferdig.** Se [forutsetninger og gjenstående protokollarbeid](davis-rs485.md).
- MariaDB/MySQL til eksisterende `wx_data`, vedvarende leveringskø, beholdt historikk ved gjentakelse, direkte privat LAN uten krav om VPN/TLS, valgfrie verifiserte TLS-forbindelser og utvidede feltkoblinger.
- Unike mTLS-identiteter, stasjonsbundet MQTT-ACL, IP- og DNS-SAN, sertifikatsperring og automatisk fjernfornyelse av enhetssertifikater uten å flytte privatnøkkelen.
- Signert OTA over eksisterende MQTT, ECDSA P-256-manifest, SHA-256, stasjons-/miljøbinding, sekvenskontroll, eksplisitt bekreftelse og tilbakeføring.
- Firmwarebygg fra adminpanelet med gatewayadresse, MQTT-port og Wi-Fi før kompilering. Separat ESP-IDF 6.1-builder uten nettverk, signering i control, kryptert enhetslager og direkte USB-pakke til nettleseren eller OTA-test over MQTT. Alle tjenester bruker UID 70001/GID 70007.
- Varig, avgrenset ESP32-sendekø i slitasjeutjevnet flash. Bare gatewayens kvittering etter varig lagring frigjør køplass. Ukjent måletid arkiveres uten oppdiktet UTC.
- Sikkerhetskopier med SQL-innstillinger og lokal værhistorikk, kontrollsum, automatisk plan/retensjon, offline restore og separat offentlig datakopi. Nøkler og hostfiler trenger også beskyttet hostbackup.
- Produksjonsstatus i panelet: faktisk sensor-/SQL-/kø-/sikkerhetsstatus samt konfigurasjonsbundne manuelle akseptanseprøver. Den blir ikke godkjent av enhetstester alene.

## Lokal verifikasjon

**169 tester bestått, ingen feil eller hoppet over.** Inkluderer serverbygg, enhetsnøkler, passordmaskering, kansellering av kompilatorens underprosesser og vertsbaserte firmwareprøver. Nye prøver dekker vindretning/Beaufort, eksplisitt klientgodkjenning, Origin, polling/WebSocket, stasjonsfiltrering, utløp/nøkkelbytte/tilbakekalling av åpne forbindelser, offentlig policyfrist og MAX3485-opptak uten UART-sending. Godkjenningens lagring og offline restore er prøvd mot ekte MariaDB. `npm audit --omit=dev` rapporterte 0 kjente sårbarheter 21. oktober 2026 etter SMTP-avhengigheten ble lagt til; denne utvidelsen legger ikke til avhengigheter.

Backendtesten inkluderer en ekte Mosquitto 2.1.2 med mTLS/IP-SAN/ACL og en egen MariaDB 11.4.13 med kopier av alle fire faktiske tabellskjemaer. De opprinnelige skjemaene beholdes uendret, inkludert NOT NULL-standardverdier, Vatnes ekstra felt og gjentakelse etter usikkert commit-resultat. Sentralt innstillingslager, migrering og offline restore er prøvd mot ekte MariaDB. SMTP uten TLS, med TLS og med påkrevd STARTTLS er prøvd mot isolerte testservere. Ingen produksjonsdata ble endret.

React-produksjonsbygg og Edge-test på desktop/mobil er gjennomført. Nettleserprøven dekker kalibreringsutkast, alarmutkast, signert firmwareutkast, historikkimport og produksjonsstatus. AD er erstattet av en kontrollert adapter bare i testoppsettet; ingen slik innlogging finnes i den deploybare applikasjonen.

Firmware **2.4.0** er kompilert med ESP-IDF **6.1**, MQTT 1.1.0 og cJSON 1.7.19~2 gjennom det faktiske skjemaet i adminpanelet. Radioprofilen er 1 086 752 byte og MAX3485-opptaksprofilen 1 086 688 byte; begge passer i 1,5 MB app-partisjoner. Nettleseren hentet de servergenererte pakkene direkte og verifiserte signatur og alle fire segmenter. Desktop/mobil, gjenbruk av byggcache, maskinvarevalg og tomt passordfelt etter innsending er kontrollert. Vindvisningen og administrasjon av godkjenninger er også prøvd på desktop/mobil. Testbyggene har utviklingsidentiteter og skal ikke flashes som produksjon. Docker-containeren er ikke kjørt lokalt, siden ingen Docker-daemon er tilgjengelig. Den faktiske C-koden for flashkø, separat konfigurasjonslager per OTA-slot og mottaksopptak er vertsbasert testet; dette erstatter ikke fysiske prøver eller en verifisert kablet ISS-dekoder.

Kjøringer og endelig antall tester dokumenteres i [akseptanseveiledningen](production-acceptance.md). DockerHub-workflowen kjører fortsatt bare bygg og publisering, som bestilt.

## Før produksjon kan godkjennes

1. Start begge stakker på faktisk Docker/Portainer-host. Prøv volumer, rettigheter, nettverk, ressursgrenser, sertifikater og omstart.
2. Bygg med ekte stasjonsidentiteter. Kontroller fysisk ESP32-revisjon før valg av Secure Boot-profil, nøkkelbackup og irreversible eFuse-tiltak. Sikkerhetsprofilen er klargjort; eFuses er ikke aktivert eller prøvd her.
3. Prøv radio, kalibrering og sender-ID på alle fire ISS-stasjonene. Sammenlign målinger med Davis/Weather Display. Prøv nettutfall, full kø, strømkutt, sertifikatfornyelse, OTA og feil gateway-IP.
4. Fullfør Apache/DNS/brannmur og kontroller adminisolasjon utenfra over både IPv4 og IPv6. Apache-arbeidet er utsatt etter avtale.
5. Prøv restore av database, enhetsidentiteter og nøkler isolert. Sammenlign levende filer og Socket.IO med Sunnmørsvær og avtalte WD-rapporter.

## Avgrensninger som ikke skal skjules

- Referanse-ET og våttemperatur er implementert, men krever blant annet absolutt stasjonstrykk. ISS sender ikke dette; resultatet for de valgte stasjonene er derfor manglende inntil en kilde tilføres.
- Solskinn fra globalstråling er et estimat. Vindkast fra ISS-kadens er ikke sertifisert høyfrekvent WMO-måling. En full sendekø kan miste nye pakker og viser antall tap.
- Absolutt bit-/formatekvivalens med alle Weather Display-funksjoner er ikke bevist. Kamera/video, tale, reléstyring, eksterne sensormoduler og alle leverandørens mal-/rapportvarianter er ikke implementert bare fordi de finnes i WD. [Matrisen](weather-display-scope.md) beskriver dette eksplisitt.
- Netatmo er utsatt etter brukerens avklaring. ISS-repeatere, WeatherLink IP og USB-host er ikke valgt datavei.
- Kablet ISS har ikke en verifisert ramme-/kontrollsumdekoder. MAX3485-profilen kan derfor ikke erstatte Davis-konsollen som værdatakilde ennå. Ingen antakelse om LOOP/LOOP2 eller radioformat brukes for å skjule dette.

Det som gjenstår på målutstyret kan ikke erstattes av en `.env`-verdi eller omtales som allerede verifisert.

Se [endringene 21. oktober](operations-20261021.md) for sentralt MariaDB-innstillingslager, varsling, USB-kvittering, beholdte måleverdier og publisering uten SDK-bygg.
