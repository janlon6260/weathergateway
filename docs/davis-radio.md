# Direkte mottak fra Davis ISS

Avklart med eier: ESP-WROOM-32, 4 MB flash, Adafruit RFM69HCW breakout produkt 3070 og europeiske ISS-stasjoner på 868 MHz. Lufttrykk skal stå som manglende inntil videre. Konsollen og WeatherLink er ikke nødvendig for denne mottaksveien.

## Fysisk kobling

Dette er prosjektets standardkobling for et nytt oppsett, ikke en påstand om hvordan eksisterende kort allerede er koblet. SPI og radiopinner kan endres i adminpanelet. Alle seks GPIO må være forskjellige. Flash-pinner og oppstartspinner tillates ikke av konfigurasjonsskjemaet.

| Adafruit 3070 | ESP-WROOM-32 |
| --- | --- |
| VIN | 3V3 |
| GND | GND |
| SCK | GPIO18 |
| MISO | GPIO19 |
| MOSI | GPIO23 |
| CS | GPIO27 |
| RST | GPIO14 |
| G0 / DIO0 | GPIO26 |

Bruk antenne tilpasset 868 MHz på breakoutens antennetilkobling. CP2102 brukes til PC/flashing; den mottar ikke ISS-signalet. Beskrivelsen gjelder Adafruits breakout med regulator og nivåtilpasning, ikke en vilkårlig løs radiobrikke. [Adafruits produktinformasjon](https://www.adafruit.com/product/3070) og [pinnebeskrivelse](https://learn.adafruit.com/adafruit-rfm69hcw-and-rfm96-rfm95-rfm98-lora-packet-padio-breakouts/pinouts) dokumenterer grensesnittet.

Sender-ID i panelet bruker Davis-nummereringen **1–8**. Radiopakken inneholder 0–7. Standardverdien 1 er et synlig oppsettvalg som må kontrolleres mot ISS; systemet knytter seg aldri automatisk til den første stasjonen det hører. Hvert ESP-oppsett tar imot én konfigurert ISS-ID. ID-er kan gjenbrukes på geografisk adskilte stasjoner.

## Mottaker og frekvenshopping

`firmware/main/davis_rfm69.c` er en ESP-IDF-driver for SPI2. Den mottar bare; den sender ingen RF-pakker og aktiverer ikke effektforsterkerne. Profilen bruker FSK, 19,2 kbit/s, Davis-synkroniseringsordet `CB 89`, ti byte fast pakkelengde, 25 kHz mottakerbåndbredde og 50 kHz AFC-båndbredde. Maskinvarens CRC, AES og adressefiltrering er slått av for å kunne behandle Davis-formatet.

Den europeiske tabellen er kontrollert mot [DavisRFM69s faktiske EU-tabell](https://github.com/dekay/DavisRFM69/blob/master/DavisRFM69.h), som har **fem** kanaler. Den eldre wiki-teksten sier fire og skal derfor ikke brukes til å velge kanaltall. Registerordene er `D90445, D91304, D921C2, D90BA4, D91A63` i denne rekkefølgen, ved 32 MHz referanse. Det tilsvarer omtrent 868,0667 / 868,2971 / 868,5275 / 868,1819 / 868,4123 MHz. Dette er registerberegnede verdier; de er ikke målte frekvenser på eierens stasjoner.

Ved søk holder mottakeren hver kanal i 16 sekunder, slik at hele femkanalssyklusen kan passere. Etter en gyldig pakke med riktig ID går den til neste kanal. Forventet intervall er `2,5 s + (ID−1) × 62,5 ms`. Tidsplanen beholder mikrosekundpresisjon. En uteblitt pakke gir et nytt hopp etter et 150 ms mottaksvindu. Mottakeren beholder forventet fase gjennom opptil 25 uteblitte pakker før den går tilbake til søk. SPI-/modusfeil gir ny initialisering etter 30 sekunder. Feil radiokobling stopper ikke MQTT-kommandobehandlingen.

Fra firmware **2.4.2** kjører `wg_radio_receiver.c` radiopollingen i en separat FreeRTOS-task med 5 ms intervall. MQTT, TLS, JSON, flashkø og loggpublisering kjøres i forbrukeren. En RAM-kø på 16 pakker dekker omtrent 40 sekunder ved ID 1; full kø telles i `radio.queueDropped`, mens radioen fortsetter å hoppe. Wi-Fi-/gatewaybortfall bruker den eksisterende varige flashkøen. Mottakstidspunktet følger pakken gjennom RAM-køen, slik at en forsinket forbruker ikke gir gamle data et nytt måletidspunkt. Endring av radiokonfigurasjon tømmer RAM-køen under samme lås som radiodriveren; identisk radiokonfigurasjon ved MQTT-omstart beholder fase og kø.

FIFO-overflyt og ugyldige pakker hindrer ikke lenger et planlagt hopp. Etter en forsinkelse hopper driveren direkte frem alle utløpte tidsluker. En FIFO-pakke som er lest etter det forventede mottaksvinduet forkastes fremfor å flytte hoppeklokken til et gammelt mottak. PayloadReady i radioregisteret er autoritativt; et lavt DIO0-nivå blokkerer ikke lenger en ferdig pakke. Publisering bruker MQTT-bibliotekets kø, og bare eldste varige målepost sendes frem til applikasjonskvitteringen. Bibliotekets API-lås kan fortsatt vente på nettverket, som er grunnen til at radiotasken aldri kaller MQTT.

FIFO leses først etter PayloadReady. Biter vendes per byte før CRC-CCITT/XMODEM kontrolleres over de første åtte bytene. De siste to bytene må være `FF FF`, som avgrenser til direkte ISS. Repeaterpakker er ikke implementert. CRC-feil, andre sender-ID-er og overrun forkastes. Mottak uten en gyldig pakke i 15 sekunder markeres som tapt sensorkontakt. RSSI og kanal følger råpakken til gatewayen.

Helsestatus hver femte sekund inneholder en separat `radio`-del med søk/sporing/feil, ISS-ID, lyttekanal **1–5**, siste mottakskanal, ISS-RSSI, mottatte/uteblitte pakker, CRC-/SPI-/FIFO-feil, resynkroniseringer, gamle FIFO-pakker, lengste pollpause og køtap. Disse vises under **Enheter → Mer om ESP-helse**. Telemetriens eksisterende `source.channel` beholder **0–4** av hensyn til kontrakten. Wi-Fi-RSSI holdes separat. USB- og MQTT-loggen får også en `davis_radio: RX:`-oppsummering; selve `Sensor packet received`-linjen er begrenset til én per ti sekunder og er ikke en pakketeller.

Registerbetydningene er kontrollert mot [HopeRF RFM69HCW V1.1](https://cdn-shop.adafruit.com/product-files/3076/RFM69HCW-V1.1.pdf). Davis-formatet bygger på den opprinnelige [RF-undersøkelsen](https://github.com/dekay/DavisRFM69/wiki/RF-Protocol), [pakkeundersøkelsen](https://github.com/dekay/DavisRFM69/wiki/Message-Protocol) og den fungerende [referansemottakeren](https://github.com/dekay/DavisRFM69/blob/master/DavisRFM69.cpp). Prosjektets driver er skrevet for ESP-IDF; AVR-/Arduino-biblioteket er ikke inkludert som avhengighet.

### Mottakerprofil fra 2.4.3

Den neste fysiske loggen fra 2.4.2 viste bare fem gyldige pakker og 55 CRC-feil ved 239 sekunder oppetid. Pollpausen var maksimalt 7 ms, uten SPI-feil, FIFO-overflyt eller køtap. Eier oppgir fem meters avstand og tilpasset 868 MHz-antenne. Det peker mot RF-mottaket fremfor nettverksblokkering, men loggen inneholder ikke råpakkene eller bakgrunnsstøyen og fastslår derfor ikke den fysiske årsaken.

2.4.3 bruker de dokumenterte innstillingene i Davis-referansemottakeren: RSSI-trigger **−85 dBm** og to tillatte bitfeil i synkroniseringsordet. Davis-payloaden krever fortsatt korrekt CRC, riktig sender-ID og `FF FF`-avslutning; det utføres ingen reparasjon av værdata. Den tidligere fabrikktriggeren −114 dBm kunne starte AGC/AFC på svak støy før ISS-preambelen. Dette er en mulig mekanisme i dette tilfellet, ikke en målt forklaring på alle de avviste pakkene.

**RSSI-trigger (dBm)** finnes både i serverbyggskjemaet og under enhetsinnstillinger. Området er −120 til −40 dBm, i hele dB. Mer negative verdier tar med svakere signaler og mer støy; mindre negative verdier kan stenge ute en svak stasjon. Standard −85 dBm følger referansedriveren og er ikke en universell terskel for alle installasjoner. Feltet heter `radioRssiThresholdDbm` og er valgfritt for å bevare hashene til eldre bekreftede konfigurasjoner. Ny firmware bruker −85 dBm når feltet mangler; eldre firmware får ikke nye felt automatisk. En eksplisitt terskel krever firmware 2.4.3. Innstillingen følger vanlig lagring, test/bekreftelse og tilbakeføring.

Et RSSI-utslag uten en ferdig pakke får en maskinvarefrist: `RegRxTimeout2=32`, som er `32 × 16 / 19196 ≈ 26,7 ms`. Dette er lengre enn ISS-pakkens sendetid. Ved Timeout reinitialiseres mottak på samme kanal; hoppefasen beholdes. Tom kanal får ingen slik frist. Retuning går via FS, venter avgrenset på ModeReady/PLL og leser frekvensregistrene tilbake før RX. Dette bygger på databladets del 4.2.5 og registerbeskrivelsene 0x27/0x2A/0x2B.

Helse og logger oppgir nå trigger, RSSI mellom pakker, signalfrister, PLL-feil og AFC-korreksjon i Hz. Siste avviste pakke har årsak (`crc`, `transmitter-id` eller `repeater`), 20 heksadesimale tegn, kanal, RSSI, AFC og alder. `RF:` og `Rejected:` skrives sammen med den femsekundsvise `RX:`-oppsummeringen. RSSI mellom pakker er en øyeblikksprøve utenfor forventet mottaksvindu, ikke en kalibrert støymåling; andre sendere kan påvirke prøven. CRC-feiltelleren alene er heller ikke en presis tapsprosent for den valgte ISS-en.

## Målinger og begrensninger

Gatewayen dekoder den originale ISS-pakken; ESP32 lager ikke en kunstig WeatherLink LOOP-pakke. Hver gyldig radiopakke videresendes. `sampleSeconds` bestemmer kontaktmeldingsintervallet ved manglende mottak, ikke ISS-ens sendeintervall.

- Vindhastighet og retning finnes i hver pakke. Temperatur, fukt, regn, UV og solstråling kommer i ulike pakketyper. Temperatur er et fortegnsbestemt big-endian-felt i 1/160 °F. Konfigurert Vue/Pro2-modell velger den dokumenterte retningskonverteringen. Nordtolkningen og Pro2-dødsonen må kryssjekkes fysisk, siden protokollundersøkelsen beskriver uenighet om nullverdien.
- Hvert felt har eget måletidspunkt. Holdte felt telles ikke som nye klimaprøver. Vind utløper etter 15 s, temperatur og regnrate etter 60 s, rapportert vindkast etter 120 s og fukt/UV/sol etter 150 s. Dette er prosjektets konservative visningsgrenser, ikke produsentens garanti for sensoroppdatering. Verdier utløper også i den offentlige lesekopien uten nye pakker. Ny ESP-oppstart eller konfigurasjon blander ikke gamle felt inn i den nye måleserien.
- Lufttrykk og inneklima finnes ikke i ISS-radioen. Disse feltene er tomme. Trykkavhengige beregninger, som våttemperatur, kan derfor også mangle. Ingen estimert trykkverdi fylles inn.
- UV/sol uten sensor blir manglende verdi. Pakke 9 inneholder et rapportert vindkast over en tidligere periode; mottakstidspunktet er ikke et presist tidspunkt for selve kastet. Full vindstatistikk og ekstra sensorer står fortsatt i WD-matrisen.
- Regnkalibrering er mm per vipp; synlig standard 0,2 må kontrolleres mot måleren. ISS-regntelleren er syv bit og går fra 127 til 0. Første mottak setter referanse, uten å legge eksisterende tellertall til dagens regn. Ved kontinuitet akkumuleres differansen modulo 128. Ny kalibrering gjelder bare nye vipp.
- Et helt omløp kan ikke oppdages etter et langt brudd. Med skjemaets øvre aksepterte regnrate på 5000 mm/t og en 0,2 mm måler blir et tidsrom på 18,432 s allerede tvetydig. Gatewayen bruker denne konservative grensen og en kontroll av maksimal differanse; tvetydige sprang gir ny referanse og et ufullstendig døgn. Et ISS-batteribytte kan heller ikke alltid skilles entydig fra regn. Rådata bevares for kontroll.
- En ufullstendig regndag vises som tom døgnsum i de eksisterende værfilene og som `null` i Socket.IO-døgnsvaret. Måneds-/årsrapporten viser `rainfallComplete:false` og `rainfallObservedMm` for den sikkert observerte delen. Omstart av gatewayarbeideren bevarer telleren i SQLite; ESP-omstart nullstiller ikke ISS-telleren. Kontinuitet over lokalt døgnskifte oppretter ny døgnsum uten å legge til gamle vipp.

Dekningskontrollen virker også uten flere pakker: et nytt avbrudd skjuler den løpende døgnsummen når intervallet blir tvetydig. For avsluttede døgn kreves mottak frem til døgnslutten innen samme grense. Dermed blir ikke et døgn der mottakeren stoppet tidlig, presentert som et komplett regndøgn. Vipp som kommer i et intervall over midnatt tilordnes det nye døgnet ved mottak; radioformatet gir ikke tidspunktet for hvert enkelt vipp.

ISS-radioen er et eksisterende Davis-format uten kryptografisk avsenderbevis. CRC kontrollerer overføringsfeil; sender-ID gir filtrering, ikke autentisering. mTLS beskytter forbindelsen **fra ESP32 til gatewayen**, inkludert fjernkommandoer. Gatewayen kan ikke legge kryptering til radiosenderen inne i en eksisterende Davis ISS.

## Fysisk akseptanse

Kode og kompilering erstatter ikke en radioprøve. Før produksjon må hver fysisk kombinasjon kontrolleres mot konsollen: oppstartssøk, hopping over alle fem kanaler, RSSI/antenne, riktig ID, begge stasjonsmodeller, vindretning, temperatur/fukt, kontrollerte regnvipp og frakobling. Test feil ID/pinner, bortfall og strømbrudd under test/commit/rollback. Gjennomfør en lengre sammenligning av mottatte/manglende pakker og målinger mot Davis/Weather Display. Ingen slik fysisk verifikasjon er utført på denne arbeidsmaskinen.
