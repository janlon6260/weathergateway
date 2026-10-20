# Firmware: bygg og første oppstart

Firmware 2.1.1 støtter ESP-IDF 6.0.2 og 6.1. Standardbygget bruker ESP32, DIO/40 MHz, 4 MB flash og to app-partisjoner på 1,5 MB. Bygget begrenses til `main` og komponentene applikasjonen avhenger av. Manifestet låser MQTT 1.1.0 og cJSON 1.7.19~2; Component Manager tilpasser `dependencies.lock` til den valgte SDK-en.

## Bygg på maskinen med ESP-IDF installert

Oppdater prosjektfilene først. Behold `firmware/main/provisioning.h`, enhetssertifikat, nøkkel og CA; ikke kjør verktøyet som lager testidentiteter over en produksjonsprovisjonering. Aktiver riktig ESP-IDF-terminal, og bygg fra prosjektroten:

```powershell
idf.py -C firmware -B firmware/build-short build
```

Ved bytte fra et annet SDK/Python-miljø: velg en ny mappe i stedet for å slette provisjonering eller manuelt endre CMake-cache:

```powershell
idf.py -C firmware -B firmware/build-idf61 build
```

Windows-hjelpeskriptet kan også bruke den aktive installasjonen:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-firmware.ps1
# Alternativt eksplisitt SDK og separat byggmappe:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-firmware.ps1 -SdkPath C:\esp\v6.1\esp-idf -BuildDirectory build-idf61
```

Skriptet normaliserer korte/lange Windows-stier i den genererte Python-cacheverdien bare når de peker til samme fil. Ved forskjellige Python-miljøer stopper det med beskjed om ny byggmappe. Det endrer ikke sikkerhetsprofil, enhetsnøkler eller fysisk ESP32. `-Production` gjelder separat førstegangsoppsett av maskinvaresikkerhet; valg av `production` i enhetspakken gjelder miljøtilhørighet og aktiverer ikke eFuses alene.

Bruk den signerte USB-pakken i nettleseren, eller den eksisterende ESP-IDF-flashprosedyren. Eksempel for eierens COM5 og standardprofil, etter kontroll av riktig enhet:

```powershell
idf.py -C firmware -B firmware/build-short -p COM5 flash monitor
```

Dersom du bygde i `build-idf61`, må samme `-B firmware/build-idf61` brukes ved flashing og når USB-pakken lages. Avslutt monitoren med **Ctrl+]**. `KeyboardInterrupt` / `0xC000013A` etter Ctrl+C beskriver avbrutt monitor på Windows og beviser ikke en firmwarekrasj.

## Nettverk og TLS

MQTT-klienten opprettes uten å koble til under oppstart. Firmware venter på Wi-Fi/DHCP og NTP-synkronisert klokke før DNS/TLS-arbeidet starter. Radiomottak og lokal målekø fortsetter mens nettet eller klokkesynkronisering mangler. Klienten stoppes ved tap av IP og startes igjen etter gjenoppretting. Mislykket oppstart forsøkes på nytt etter fem sekunder; ordinære MQTT-forbindelsesfeil bruker bibliotekets reconnect.

USB-loggen viser:

- Firmwareversjon og MQTT-adresse/port.
- Venting på Wi-Fi/DHCP eller NTP.
- DHCP-adresse, gateway, DNS og Wi-Fi-frakoblingskode.
- MQTT-/TLS-feilkode, sertifikatkontrollflagg og socketfeil.

`couldn't get hostname ... getaddrinfo() returns 202` betyr at navneoppslaget feilet. Første forsøk i eldre firmware kunne komme før IP/DNS var klar. Ved fortsatt feil etter `Wi-Fi ready` må DNS for `wg-api.skrg.no`, VLAN-ruting og DHCP-DNS kontrolleres. `Waiting for NTP ...` krever fungerende DNS og tilgang til `pool.ntp.org` over UDP/123. Klienten beholder full CA-/navne- og gyldighetskontroll; den bytter ikke automatisk til en annen IP eller usikker TLS.

En eksplisitt gateway-IP må stemme med enhetens konfigurasjon og finnes som IP-SAN i serversertifikatet. Vanlig `idf.py flash` beholder NVS. En eksisterende, bekreftet gatewayadresse i NVS overstyres derfor ikke av nye kompilerte standardverdier. Endre gjeldende konfigurasjon i adminpanelet når enheten er tilkoblet. Nettleserens komplette USB-installasjon sletter flash og laster provisjoneringen på nytt; det krever eksplisitt bekreftelse og mister eventuell usendt målekø.

## RFM69HCW og GPIO14

GPIO14 er standard resetpinne. ESP-IDF 6.1 reserverer GPIO-utganger. Eldre kode konfigurerte resetutgangen på nytt ved hvert mislykket radioforsøk uten å frigjøre reservasjonen. 2.1.1 frigjør GPIO og SPI både ved stopp, delvis initialiseringsfeil og neste forsøk. Den frigjør bare ressurser radiodriveren selv har opprettet. Det er ingen automatisk omkobling av pinner.

En mislykket brikkeidentifikasjon logger faktisk `RegVersion` og pinnene som brukes, og skal normalt lese `0x24`. Feil identifikasjon følges av navngitt initialiseringstrinn og et nytt forsøk etter 30 sekunder. Dersom dette fortsetter med modulen tilkoblet, kontroller 3,3 V, felles jord og ledningene mot den faktiske konfigurasjonen. En korrekt programvareopprydding kan ikke bekrefte fysisk SPI-forbindelse. Følg [koblingsskjemaet](davis-radio.md).

GPIO14-advarselen alene beviser ikke at ISS-frekvensen eller sender-ID er feil. Brikkeidentifikasjon og mottakermodus må fungere før mottak av værpakker kan kontrolleres.

## Øvrige meldinger i det innsendte eksemplet

- `Project build complete`, fire vellykkede hashkontroller og app med 32 % ledig partisjonsplass viser at bygg og flashing ble fullført.
- BOYA-meldingen sier at en generisk flashdriver brukes. BOYA-støtte er lagt i standardkonfigurasjonen for nye bygg. Eksisterende `sdkconfig` beholdes og kan konfigureres med `idf.py menuconfig`; advarselen er ikke en mislykket flashing.
- `failed to load RF calibration data (0x1102), falling back to full calibration` er forventet ved manglende lagret kalibrering, eksempelvis første oppstart med tom NVS.
- Kconfig-notiser om bool-/hex-syntaks og Wi-Fi-komponentenes private include-kataloger kommer fra den viste Espressif 6.1-kildekoden. De stoppet ikke bygget. Prosjektet undertrykker ikke globale SDK-advarsler.

Les [Espressifs GPIO-implementasjon i 6.1](https://github.com/espressif/esp-idf/blob/v6.1/components/esp_driver_gpio/src/gpio.c), [GPIO-dokumentasjonen](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32/api-reference/peripherals/gpio.html) og [tidsynkronisering](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32/api-reference/network/esp_netif_programming.html).

## Passord ved provisjonering

Unngå at `Read-Host` skriver passordet synlig i terminal og innsendte logger:

```powershell
$env:WG_WIFI_SSID = "SKRG-IoT"
$wgPassword = Read-Host "Wi-Fi-passord" -AsSecureString
try {
    $env:WG_WIFI_PASSWORD = [System.Net.NetworkCredential]::new('', $wgPassword).Password
    # Kjør provision-firmware.js med den eksisterende enhetspakken her.
} finally {
    Remove-Item Env:WG_WIFI_PASSWORD -ErrorAction SilentlyContinue
    $wgPassword.Dispose()
}
```

Den kompilerte firmwaren og provisjoneringsfilene er fortsatt sensitive og skal oppbevares beskyttet.
