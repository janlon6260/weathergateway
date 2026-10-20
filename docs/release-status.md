# Leveransestatus – 20. oktober 2026

React, Node/Express, Docker-oppsett og ESP-IDF-firmware er implementert i dette prosjektet. Denne leveransen er lokalt verifisert; den er **ikke produksjonsgodkjent på deres utstyr**. Ingen Docker-host eller fysisk ESP32 er tilgjengelig i denne økten. Det er ikke utført flashing, eFuse-endring, produksjons-DDL eller produksjonsskriving.

## Implementert

- Intern AD/LDAPS-innlogging, eksisterende grupper til roller, sesjoner, CSRF, revisjonskontroll og audit. Brukeren har bekreftet fungerende AD-innlogging.
- React-panel med en/flere/alle stasjoner, sanntidsdata, historikkgrafer, rekorder, kalibrering, kvalitetsregler, alarmregler og alarmhistorikk.
- Separate utviklings-/produksjonsstakker og data. Miljøbytte og eksplisitt overføring til produksjonsutkast. Ubekreftede innstillinger brukes ikke av SQL-levering, kalibrering, alarmregler eller backupplan.
- Vedvarende test/bekreftelse/tilbakeføring, som standard 300 sekunder, inkludert lokal ESP32-frist og uavhengig konfigurasjonsvakt.
- Direkte Davis ISS-mottak via RFM69HCW/EU868, alternativ LOOP/LOOP2, CRC, sender-ID, feltvise måletider, duplikater og manglende sensorer. Lufttrykk er etter avtale manglende.
- Værindekser, tidsvektet middelvind og retning, vindrun/vindrose, regnperioder, graddager, FAO-56 referanse-ET, astronomi og solstrålingsestimat. Se [metoder og nødvendige innganger](calculations.md).
- Eksisterende Sunnmørsvær-filer og Socket.IO-hendelser, atomiske egendefinerte tekst-/CSV-/HTML-maler, klimautdata og sporbar historikkimport med forhåndsvisning.
- MariaDB/MySQL til eksisterende `wx_data`, vedvarende leveringskø, beholdt historikk ved gjentakelse, direkte privat LAN uten krav om VPN/TLS, valgfrie verifiserte TLS-forbindelser og utvidede feltkoblinger.
- Unike mTLS-identiteter, stasjonsbundet MQTT-ACL, IP- og DNS-SAN, sertifikatsperring og automatisk fjernfornyelse av enhetssertifikater uten å flytte privatnøkkelen.
- Signert OTA over eksisterende MQTT, ECDSA P-256-manifest, SHA-256, stasjons-/miljøbinding, sekvenskontroll, eksplisitt bekreftelse og tilbakeføring.
- Varig, avgrenset ESP32-sendekø i slitasjeutjevnet flash. Bare gatewayens kvittering etter varig lagring frigjør køplass. Ukjent måletid arkiveres uten oppdiktet UTC.
- Konsistente SQLite-backuper med kontrollsum, automatisk plan/retensjon, offline restore og separat offentlig datakopi. Nøkler og hostfiler trenger også beskyttet hostbackup.
- Produksjonsstatus i panelet: faktisk sensor-/SQL-/kø-/sikkerhetsstatus samt konfigurasjonsbundne manuelle akseptanseprøver. Den blir ikke godkjent av enhetstester alene.

## Lokal verifikasjon

**117 backendtester bestått, ingen feil eller hoppet over.** Produksjonsavhengighetenes sårbarhetskontroll rapporterte 0 kjente sårbarheter 20. oktober 2026.

Backendtesten inkluderer en ekte Mosquitto 2.1.2 med mTLS/IP-SAN/ACL og en egen MariaDB 11.4.13 med kopier av alle fire faktiske tabellskjemaer. SQL-migrasjonen er prøvd der, inkludert alle værkolonner, Vatnes ekstra felter og gjentakelse etter usikkert commit-resultat. Ingen produksjonsdata ble endret.

React-produksjonsbygg og Edge-test på desktop/mobil er gjennomført. Nettleserprøven dekker kalibreringsutkast, alarmutkast, signert firmwareutkast, historikkimport og produksjonsstatus. AD er erstattet av en kontrollert adapter bare i testoppsettet; ingen slik innlogging finnes i den deploybare applikasjonen.

ESP32-firmwaren er kompilert med ESP-IDF 6.0.2, MQTT 1.1.0 og cJSON 1.7.19~2. Den passer i begge 1,5 MB OTA-partisjoner. Testbygget har utviklingsidentiteter og skal ikke flashes som produksjon. Den faktiske C-koden for flashkøen er i tillegg prøvd med vertsbasert feilinjeksjon ved avbrutt skriving, sektorvis sletting, køomløp og tap av kvitteringscheckpoint. Dette erstatter ikke en fysisk strømkuttprøve.

Kjøringer og endelig antall tester dokumenteres i [akseptanseveiledningen](production-acceptance.md). DockerHub-workflowen kjører fortsatt bare bygg og publisering, som bestilt.

## Før produksjon kan godkjennes

1. Start begge stakker på faktisk Docker/Portainer-host. Prøv volumer, rettigheter, nettverk, ressursgrenser, sertifikater og omstart.
2. Bygg med ekte stasjonsidentiteter. Kontroller fysisk ESP32-revisjon før valg av Secure Boot-profil, nøkkelbackup og irreversible eFuse-tiltak. Sikkerhetsprofilen er klargjort; eFuses er ikke aktivert eller prøvd her.
3. Prøv radio, kalibrering og sender-ID på alle fire ISS-stasjonene. Sammenlign målinger med Davis/Weather Display. Prøv nettutfall, full kø, strømkutt, sertifikatfornyelse, OTA og feil gateway-IP.
4. Ta SQL-backup, kjør den [konkrete NULL-migrasjonen](../deploy/sql/20261020-nullable-weather-measurements.sql) med egnet driftskonto og samordne bytte av skriver. Appen utfører ikke produksjons-DDL. Kontroller faktisk INSERT-/UPDATE-tilgang og levering.
5. Fullfør Apache/DNS/brannmur og kontroller adminisolasjon utenfra over både IPv4 og IPv6. Apache-arbeidet er utsatt etter avtale.
6. Prøv restore av database, enhetsidentiteter og nøkler isolert. Sammenlign levende filer og Socket.IO med Sunnmørsvær og avtalte WD-rapporter.

## Avgrensninger som ikke skal skjules

- Referanse-ET og våttemperatur er implementert, men krever blant annet absolutt stasjonstrykk. ISS sender ikke dette; resultatet for de valgte stasjonene er derfor manglende inntil en kilde tilføres.
- Solskinn fra globalstråling er et estimat. Vindkast fra ISS-kadens er ikke sertifisert høyfrekvent WMO-måling. En full sendekø kan miste nye pakker og viser antall tap.
- Absolutt bit-/formatekvivalens med alle Weather Display-funksjoner er ikke bevist. Kamera/video, tale, reléstyring, eksterne sensormoduler og alle leverandørens mal-/rapportvarianter er ikke implementert bare fordi de finnes i WD. [Matrisen](weather-display-scope.md) beskriver dette eksplisitt.
- Netatmo er utsatt etter brukerens avklaring. ISS-repeatere, WeatherLink IP og USB-host er ikke valgt datavei.

Det som gjenstår på målutstyret kan ikke erstattes av en `.env`-verdi eller omtales som allerede verifisert.
