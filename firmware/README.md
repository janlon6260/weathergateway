# ESP-WROOM-32 / Davis

ESP-IDF 6.0.2, ESP32 med 4 MB flash, uten krav til PSRAM. MQTT 1.1.0 og cJSON 1.7.19~2 er låst i `dependencies.lock`. CP2102 er USB/seriebrikken og sier ikke hvilken sikkerhetsrevisjon ESP32 har.

## Radio og IP

Avklart: Adafruit RFM69HCW 3070 og direkte europeisk Davis ISS på 868 MHz. SPI-standard er SCK18, MISO19, MOSI23, CS27, RST14 og DIO0/G0 på GPIO26; VIN til 3V3 og GND til GND. Se [kobling, hopping, sender-ID og fysisk prøve](../docs/davis-radio.md). Lufttrykk er manglende etter avtale.

Gateway kan angis med IP eller DNS-navn. IP må stå som **IP-SAN** i brokerens sertifikat. Sett `WG_MQTT_SERVER_NAMES` ved host-bootstrap dersom enhetene bruker andre adresser enn `WG_PUBLIC_ORIGIN`. CA-/navnekontroll beholdes også ved IP-tilkobling. ESP32 oppretter den utgående mTLS-forbindelsen; gatewayens kommandoer kommer tilbake over denne forbindelsen. En ESP32 trenger ingen innkommende internettport.

## Provisjonering og vanlig kompilering

1. Last ned unik enhetspakke fra riktig stasjon og miljø. Behold den beskyttet: den inneholder privatnøkkel og stasjonsidentitet og trengs ved senere bygg.
2. Sett `WG_WIFI_SSID` og `WG_WIFI_PASSWORD` i prosessmiljøet. Ikke legg dem i Git eller kommandologg.
3. Kjør `node scripts/provision-firmware.js /beskyttet/enhetspakke.json` fra prosjektroten. Git-ignorerte `provisioning.h`, CA, enhetssertifikat og nøkkel skrives til `firmware/main`. Erstatning krever `WG_REPLACE_PROVISIONING=true`.
4. Bygg i ESP-IDF 6.0.2 med `idf.py -C firmware build`, eller på denne Windows-maskinen `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-firmware.ps1`. Det siste bruker `build-short` og SDK under `.tools`.
5. Kontroller begge 1,5 MB OTA-slots. Vanlig utviklingsbygg aktiverer ikke Secure Boot eller flashkryptering.

`node scripts/firmware-build-check.js` oppretter utviklingsidentiteter for `.invalid`, bare for kompilering. Disse kan ikke autentisere mot produksjon og skal ikke flashes som produksjonsfirmware. Ingen fysisk flashing er utført i denne økten.

## Første sikkerhetsprovisjonering

[sdkconfig.production.defaults](sdkconfig.production.defaults) og [partitions.production.csv](partitions.production.csv) klargjør Secure Boot V2, flashkryptering i release-modus og NVS-kryptering for **fysisk verifisert ESP32 revision 3.0+**. NVS-nøkkelpartisjonen er separat og kryptert. Partisjonstabell/NVS flyttes; denne profilen er en førsteprovisjonering, ikke en OTA-migrasjon fra vanlig utviklingspartisjonering.

Windows-bygg:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-firmware.ps1 `
  -Production -HardwareRevision 300 -SecureBootSigningKey C:\beskyttet\secure-boot-rsa3072.pem
```

Verktøyet krever en beholdt RSA-3072-privatnøkkel og lager et separat `build-production`. Det flasher ikke kortet. Første oppstart av et slikt korrekt provisjonert sikkerhetsbygg kan sette **irreversible eFuses** og begrense senere seriell flashing. Les Espressifs prosedyre, prøv på eget pilotkort og sikkerhetskopier produksjonsnøklene før fysisk bruk. Den faktiske kortrevisjonen er ennå ikke tilgjengelig; sikkerhetsprofilen er ikke fysisk verifisert her. For eldre ESP32 må egnet sikkerhetsprofil/maskinvare velges etter revisjonskontroll.

RSA-nøkkelen for Secure Boot er forskjellig fra ECDSA P-256-nøkkelen som signerer gatewayens OTA-manifest. Begge må håndteres og bevares riktig. [Espressif Secure Boot V2](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/security/secure-boot-v2.html), [flashkryptering](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/security/flash-encryption.html).

## Test, tilbakeføring og signert OTA

Standardprofilen kan installeres fra **Enheter** i adminpanelet med en signert `.usb-flash.json`-pakke. USB-logg og nettverkslogg via MQTT beskrives i [nettleserveiledningen](../docs/esp32-browser.md). Maskinvaresikret førstegangsoppsett over gjøres fortsatt med ESP-IDF.

Konfigurasjon har aktiv/forrige/kandidat i NVS, UTC-frist og monoton frist. Uavhengig vakt restarter ved utløpt test selv om nettverksoppgaven stopper. Oppstart under konfigurasjonstest gjenoppretter bekreftet innstilling. Gatewayen krever kandidatkvittering og ferske, gyldige sensordata før «Gjør gjeldende», og venter deretter på commit-kvittering.

OTA bruker SHA-256 og et ECDSA P-256-signert manifest bundet til stasjon, miljø, versjon, sekvens og bildestørrelse. Bildet lastes i avgrensede MQTT-blokker til den andre app-partisjonen. En ny app må sende gyldig sensordata og MQTT-publiseringskvittering; administrator må også bekrefte før fristen. Uten bekreftelse går enheten tilbake. Secure Boot-profilen krever i tillegg et korrekt RSA-signert appbilde. Se [signering og drift](../docs/firmware-lifecycle.md).

## Varig sendekø og sertifikater

Råpakker lagres i avgrenset slitasjeutjevnet flash med CRC og vedvarende kvitteringspunkt. Køen tåler gjentakelser og avbrutte poster; bare en applikasjonskvittering etter gatewayens varige lagring frigjør posten. Kapasitet, ventende poster og tapte nye poster rapporteres i panelet. Ved full kø beholdes eldre poster og nye kan gå tapt; det loves ikke ubegrenset historikk.

Før klokken er synkronisert beholdes monotont tidspunkt. Etter synkronisering kan samme oppstarts måletid rekonstrueres. Ukjent tid fra en tidligere oppstart arkiveres diagnostisk og settes ikke til en oppdiktet UTC-tid.

Enhetssertifikatet fornyes automatisk nær utløp, med eksisterende privatnøkkel. Kandidaten prøves med ny MQTT-forbindelse og har lokal tilbakeføring. Den gamle identiteten sperres først når gatewayen har mottatt bekreftelse fra den nye. Fysisk strømkutt, pakketap, feil IP, full kø og radio må fortsatt prøves på pilotkort og hver stasjon.
