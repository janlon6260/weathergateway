# ESP-WROOM-32 / Davis

ESP-IDF 6.0.2, ESP32 med 4 MB flash, uten krav til PSRAM. Komponentene er låst til Espressif MQTT 1.1.0 og cJSON 1.7.19~2. `dependencies.lock` inngår i versjonskontroll. CP2102 er PC-ens USB/seriegrensesnitt for flashing, ikke Davis-radio.

## Davis-radio

Avklart maskinvare er Adafruit RFM69HCW produkt 3070, direkte fra europeisk Davis ISS på 868 MHz. [Radioveiledningen](../docs/davis-radio.md) inneholder koblingstabell, kildegrunnlag, hopping, sender-ID, dekoding og fysisk akseptanse. Lufttrykk er etter avtale ikke tilkoblet foreløpig.

SPI-standard: SCK18, MISO19, MOSI23, CS27, RST14 og G0/DIO0 på GPIO26. VIN kobles til 3V3 og GND til GND. Sender-ID 1–8 og pinnene styres fra panelet med samme test/bekreftelse/rollback som gatewayadressen. Standard-ID 1 må kontrolleres på ISS; ingen automatisk binding til en tilfeldig sender. Hver gyldig ti-byte ISS-pakke med riktig ID videresendes til gatewayen sammen med RSSI og kanal.

Den tidligere UART-driveren er bevart som alternativ for eksisterende seriekonfigurasjoner og regresjonstester. Den bruker 99-byte WeatherLink LOOP/LOOP2. USB-host, WeatherLink IP og ISS-repeatere er ikke implementert.

## Provisjonering og bygg

1. Last ned unik enhetspakke fra riktig stasjon og miljø i panelet. Behandle JSON-pakken som en hemmelighet.
2. Sett `WG_WIFI_SSID` og `WG_WIFI_PASSWORD` i prosessmiljøet. WPA2-passord: 8–63 byte; SSID: 1–32 byte. Ikke skriv verdiene i kommandohistorikk eller versjonskontroll.
3. Kjør `node scripts/provision-firmware.js /beskyttet/enhetspakke.json` fra prosjektroten. Verktøyet lager git-ignorerte `firmware/main/provisioning.h`, `ca.pem`, `device.pem` og `device.key`. Eksisterende provisjonering overskrives bare med `WG_REPLACE_PROVISIONING=true`.
4. I aktivert ESP-IDF 6.0.2: `idf.py -C firmware build`. På denne Windows-maskinen bruker `scripts/build-firmware.ps1` SDK-en under `.tools`, korte Windows-stier og mappen `build-short`; ingen global SDK-installasjon er nødvendig. Etter dette bygget brukes `cd firmware` og `idf.py -B build-short -p RIKTIG_SERIEPORT flash monitor` ved eventuell fysisk flashing.
5. Kontroller at appen passer i begge OTA-slots på 1,5 MB. Flash bare riktig fysisk kort med `idf.py -C firmware -p RIKTIG_SERIEPORT flash monitor`. Ingen fysisk flashing er utført her.

`node scripts/firmware-build-check.js` lager midlertidige utviklingsnøkler og provisjonering for `firmware-build.invalid`, bare for kompilering. De kan ikke autentisere mot deployede stacker. Ikke bruk testbildet som produksjonsfirmware. Skriptet overskriver heller ikke eksisterende provisjonering uten eksplisitt erstatningsvalg.

RF-testbygget 19. oktober 2026 kompilerte til omtrent 1,03 MB, med 35 % ledig plass i minste app-partisjon. Midlertidig provisjonering fjernes etter verifikasjon; bruk en ekte enhetspakke før eget bygg. ESP-IDF ga enkelte Kconfig-notiser om standardverdier og deprekasjoner i leverandørkoden. Ingen fysisk drift eller eFuse-endring er utført.

## Lokal sikkerhetsmekanisme

MQTT 5 bruker mTLS, CA- og vertsnavnkontroll. Enheten aksepterer bare eget eksakt kommandoemne og begrensede meldinger. Kommando-ID, sekvens og utløp kontrolleres; høyeste kritiske sekvens og siste handling lagres før utførelse. Wi-Fi bruker begrenset eksponentiell nytilkobling.

Aktiv, forrige og kandidatkonfigurasjon ligger i en versjonert NVS-post. Testen har UTC-frist og monoton lokal frist. Strømbrudd under test gjenoppretter bekreftet innstilling. Gatewayen krever både kvittering og nye sensordata med kandidatens hash før commit; faktisk commit-ACK fullfører servertilstanden. Feil gatewayadresse rulles tilbake lokalt selv om serveren ikke kan nå enheten.

En OTA-partisjon som venter på verifisering må levere gyldig Davis-pakke og MQTT-publiseringskvittering før den markeres gyldig. Dette er ikke et komplett OTA-system: nedlasting, signerte utgivelser, fjernfornyelse av sertifikater og varig mellomlager under nettutfall gjenstår.

Secure Boot, flash-/NVS-kryptering og eFuse-endringer aktiveres ikke automatisk. Faktisk silisiumrevisjon og produksjonsnøkkelhåndtering må verifiseres før irreversible tiltak. Bygg med innebygde enhets-/Wi-Fi-nøkler er sensitive selv om filene er git-ignorert.

Fysisk akseptansetest må omfatte Davis-interface, TLS-feil, feil brokeradresse, strømkutt under NVS-skriving, tidsendring og tapte/dupliserte test-/commitmeldinger.
