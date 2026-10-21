# ESP32: nettleserflashing og sanntidslogger

Åpne **Enheter → ESP32 · USB-flashing og sanntidslogg** i adminpanelet. Administrator kan flashe; administrator og operatør kan lese logger. Adminpanelet forblir tilgjengelig bare på internt nett/VPN. Nettverksloggen bruker den eksisterende MQTT-forbindelsen med TLS og enhetssertifikat. Ingen ny port åpnes på ESP32 eller gatewayen.

## Flash via USB

Bruk Chrome eller Edge på en datamaskin, og HTTPS med et betrodd sertifikat, eller `localhost` under utvikling. Koble ESP32 til datamaskinen som kjører nettleseren. Docker-hosten trenger ingen USB-montering. CP2102/CH340 må ha fungerende driver i operativsystemet. Lukk andre programmer som bruker samme COM-port.

Under **Bygg firmware på serveren**, fyll inn gatewayens IP/DNS-navn, MQTT-port, Wi-Fi SSID og Wi-Fi-passord. Velg **USB på denne datamaskinen** og **Kompiler på serveren**. Byggloggen vises i panelet. Når bygget er ferdig, velg **Klargjør USB-flashing**. Nettleseren henter den signerte pakken direkte fra kontrollserveren; du trenger ingen lokal kompilator, manuell filoverføring eller opplasting.

Serveren utsteder en unik enhetsidentitet dersom den mangler, ellers gjenbrukes eksisterende privatnøkkel. Første oppsett av CA og MQTT-sertifikater gjøres under **Sertifikater**. Gatewayadressen må finnes i MQTT-serversertifikatets SAN. Enhetssertifikatets varighet kan velges opptil 50 år, begrenset av CA-ens utløpsdato. Se [byggtjenestens oppsett og lagring](firmware-server-builds.md).

1. Velg riktig stasjon og **USB på denne datamaskinen**.
2. Koble fra USB-loggen dersom den er aktiv. Bruk **Klargjør USB-flashing** etter serverbygget. En eksisterende `.usb-flash.json` kan også velges manuelt.
3. Nettleseren kontrollerer SHA-256 for alle segmentene. Gatewayen kontrollerer signatur, miljø, stasjon, gjeldende konfigurasjon og at enhetssertifikatet fremdeles er gyldig.
4. Bekreft sletting og velg **Flash valgt ESP32**. Velg riktig COM-port i nettleserens dialog. Ved behov: hold BOOT inne under tilkoblingen.
5. Verktøyet kontrollerer chip, 4 MB flash og sikkerhets-eFuses før sletting. Bootloader, partisjonstabell, OTA-data og app skrives. Alle segmentene leses tilbake og SHA-256-verifiseres før omstart.
6. Velg **Koble til USB-logg** for å følge oppstart og tilkobling.

USB-installasjonen sletter **hele ESP-ens flash**, inkludert gamle innstillinger, sertifikater og mellomlagrede målinger. Den lokale operasjonen har ingen fem minutters tilbakeføring. Bruk eksisterende signert OTA med test/bekreft for vanlig fjernoppdatering. Ved avbrutt USB-flashing må hele pakken flashes på nytt.

Nettleserflasheren støtter standardprofilen for ESP-WROOM-32 med 4 MB flash. Den brenner ikke eFuses. Førstegangsaktivering av Secure Boot/flashkryptering og lokal gjenoppretting av allerede sikrede kort utføres med ESP-IDF og riktig beholdt nøkkel. Slike kort avvises av nettleserflasheren og bruker signert OTA til ordinære oppdateringer.

## Oppdater via nettverk

Velg **Nettverk via MQTT/TLS (OTA)** før kompilering og deretter **Start OTA-test** på det ferdige bygget. ESP32 laster ned signerte firmwareblokker via sin eksisterende mTLS-forbindelse. Kontroller nye sensormålinger under **Endringer**, og velg **Gjør gjeldende** før testfristen utløper (normalt fem minutter). Manglende kvittering, feil målinger eller utløpt frist hindrer godkjenning og gir tilbakeføring.

Firmware 2.2.0 lagrer enhetskonfigurasjon separat per OTA-slot. Nye kompilerte gateway-/portinnstillinger og Wi-Fi tas i bruk i testbildet. Ved tilbakeføring bruker det forrige bildet sin egen konfigurasjon og sitt innebygde Wi-Fi-oppsett. Serverens bekreftede enhetskonfigurasjon endres først når enheten har kvittert for godkjenningen. Innstillinger kan ikke testes samtidig med firmware på samme enhet.

For enheter som ble klargjort før serverbygg ble innført, bruk **Importer eksisterende enhetsidentitet** én gang med den opprinnelige enhetspakken. Enhetens privatnøkkel kan ikke rekonstrueres fra sertifikatet. Alternativt installer en ny identitet via USB. Serverbyggerens standardprofil kan ikke brukes til OTA på et kort som krever en separat Secure Boot-signatur.

## Logger via USB

Velg **Koble til USB-logg**, riktig COM-port og normalt **115200 baud**. Avleseren håndterer oppdelte UTF-8-tegn og kabelbrudd. USB-porten kan bare brukes til én operasjon om gangen. Terminalen viser tekst uten å tolke HTML eller terminalkommandoer. **Pause visning**, **Tøm visning**, søk og **Last ned logg** virker på den lokale visningen. USB-data sendes ikke til serveren. ROM-/bootloaderlogger før MQTT er tilkoblet er bare tilgjengelige via USB.

## Logger via nettverk

Installer firmware **2.1.0 eller nyere** på enheten og oppdater både control, worker og brokerens genererte ACL. Velg stasjon, **Nettverk via gateway/MQTT** og **Start nettverkslogg**. Enheten kvitterer for en tidsavgrenset `stream_logs`-kommando. Logglinjene fra ESP-IDFs ordinære logging videresendes til stasjonens eget `logs`-emne; gatewayen leverer dem til adminpanelet med ett sekunds intervall.

Firmware logger gatewayens livsløp på INFO og SDK-advarsler/feil. Nettverksloggen krever fungerende Wi-Fi, korrekt klokke og MQTT-tilkobling. Den leser ikke historiske bootlogger. Enhetens IP og Wi-Fi-signal rapporteres i status på enhetskortet, i tillegg til eksisterende ISS-RSSI.

Økten fornyes hvert minutt mens visningen er åpen. Ved lukking eller stopp sendes en stoppkommando. Ved nettbrudd eller lukket nettleser utløper firmwareøkten med en monoton frist, senest etter to minutter uten fornyelse. En ny visning av samme stasjon erstatter den gamle. Utlogget eller utløpt AD-sesjon kan ikke forlenge økten.

`ER_NO_SUCH_TABLE` ved `GET /api/devices/:id/logs?after=0` skyldtes en JOIN mellom lokal loggøkt og kommandoer i MariaDB. Leseren henter nå disse separat og setter sammen resultatet. Det kreves ingen manuell oppretting av loggtabeller i MariaDB. Regresjonen kjører start av loggøkt, kommando-ACK, logglinje og videre polling gjennom HTTP mot ekte MariaDB.

Firmware bruker en RAM-kø på 16 linjer, opptil 384 tegn per linje og maksimalt fem videresendte linjer per sekund. Diagnostikk bruker QoS 0 og er ikke retained. Køoverløp telles, og værmålinger beholder egen varig kø og prioritet. Worker begrenser loggraten separat fra måleraten og avviser meldinger med feil identitet, ukjent/utløpt økt eller retained-flagg. Gatewayen oppbevarer høyst 1000 linjer per stasjon i én time; de kopieres ikke til den offentlige databasen/API-et. Terminalen i nettleseren begrenses også til 1000 linjer / 200 kB. Wi-Fi-passord maskeres på enheten før nettverksoverføring, og serveren fjerner kontrollsekvenser og gjenkjennelige hemmelighetsfelt.

Implementasjonen bruker [Espressifs esptool-js](https://github.com/espressif/esptool-js), [Web Serial](https://developer.chrome.com/docs/capabilities/serial) og [ESP-IDFs reentrante logghook](https://docs.espressif.com/projects/esp-idf/en/v6.0.2/esp32/api-reference/system/log.html). Biblioteket pakkes sammen med frontend og lastes ikke fra eksternt CDN. CI bygger Docker-imaget; det kjører ingen tester.

## Fysisk akseptanse

Lokale tester dekker pakkesignaturer, kontrollsummer, roller/CSRF, USB-tilstandsmaskin med simulert serialport, begrenset logging og ekte MQTT/mTLS med stasjonsisolasjon. Før utrulling skal en fysisk ESP-WROOM-32/CP2102 testes: førstegangsflashing, verifisering, oppstart, USB-kabelbrudd, nettverkslogg med ISS-mottak og automatisk stopp ved nettbrudd. Nettlesersimulering erstatter ikke denne maskinvareprøven.
