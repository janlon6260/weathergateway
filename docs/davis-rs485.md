# Direkte kablet Davis ISS via MAX3485

Firmware 2.4.1 støtter direkte kablet **Vantage Pro2 ISS uten Davis-konsoll**. Velg **Kablet ISS – MAX3485, uten konsoll** før serverbygg i adminpanelet. Driveren produserer værdata og støtter både USB-installasjon og signert OTA. Den tidligere opptaksprofilen er erstattet av en egen værdatadriver.

## Dokumentert protokoll og integritet

Den opprinnelige implementatøren, dwall, beskrev 21. august 2017 native **4800 baud, 8N1 og seks payload-byte uten kontrollsum**. Beskrivelsen finnes i en [offentlig arkivkopi av originaltråden](https://web.archive.org/web/20220810015612/https://www.wxforum.net/index.php?topic=32706.0). Andre deltakere i samme tråd rapporterer fungerende oppsett. Det aktive forumet krevde nettleserverifisering, men arkivkopien gjorde protokollopplysningene lesbare.

Feltkodingen følger de seks databytene som beskrives i [den opprinnelige DavisRFM69-protokollanalysen](https://github.com/dekay/DavisRFM69/wiki/Message-Protocol). Implementasjonen er selvstendig og bruker:

| Byte | Betydning                                                                                  |
| ---- | ------------------------------------------------------------------------------------------ |
| 0    | Meldingstype og ISS-status                                                                 |
| 1    | Vindhastighet i mph, omregnet til m/s                                                      |
| 2    | Vantage Pro2-vindretning                                                                   |
| 3–5  | Temperatur, fuktighet, regnteller/-rate, vindkast, UV eller solstråling etter meldingstype |

Temperatur er signert og omregnes til °C. Manglende sensorer beholdes manglende. Regntelleren håndteres som en rullerende sjubits teller; varig servertilstand, idempotens og eksplisitt usikkerhet ved lange utfall hindrer at oppstart/gjentakelse blir falsk nedbør. Bøttestørrelsen kommer fra stasjonsinnstillingene. Lufttrykk og innendørsklima finnes ikke på denne ISS-forbindelsen.

ESP32 bruker [UART-hendelser og hardware idle-timeout](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/uart.html), ikke tiden mellom applikasjonens pollinger, til rammeavgrensning. Timeout på 20 UART-symboler er driverens valgte avgrensning, ikke en ny Davis-baudrate eller en del av payloaden. Bare en komplett seksbytesramme med kjent meldingstype godtas. Feil lengde, UART-feil, break, støy og overflyt forkaster rammen; neste rene idle-grense gjenoppretter avgrensningen. Driveren sender aldri kommandoer på ISS-bussen.

**Kabelprotokollen har ingen CRC.** Det er derfor ikke mulig å oppdage enhver bitfeil i ellers plausible data. Driveren legger ikke til en fiktiv CRC og presenterer ikke disse pakkene som radioverifiserte. Serveren markerer `quality.linkChecksum: "none"`; helse viser også `checksum: "none"`. Stasjonens område-/endringsregler brukes som ellers. ESP32–gateway er fortsatt kryptert og autentisert med MQTT/mTLS.

## Tilkobling og strøm

Bruk **3,3 V MAX3485** mot ESP32. MAX485 er en 5 V-komponent og krever egnet nivåtilpasning på logikksiden. Se produsentens [MAX3485](https://www.analog.com/en/products/max3485.html) og [MAX485](https://www.analog.com/en/products/max485.html).

| MAX3485 | ESP32, standardvalg                                   |
| ------- | ----------------------------------------------------- |
| VCC     | 3,3 V                                                 |
| GND     | GND / signalreferanse                                 |
| RO      | GPIO16                                                |
| DE      | GPIO25, holdes lav                                    |
| /RE     | GPIO26, holdes lav under mottak                       |
| DI      | Ingen ESP32-TX; hold inngangen på definert lavt nivå  |
| A/B     | ISS-ens differensielle datapar, med korrekt polaritet |

Sørg for ekstern pulldown på DE slik at senderen også er deaktivert under reset. Firmware styrer ikke en automatisk RS-485-sender og konfigurerer ingen UART-TX. GPIO kan endres i panelet; flash-, strapping- og kolliderende pinner avvises. Baudrate er fast 4800.

**ISS trenger egen 5 V-forsyning når konsollen fjernes. MAX3485s 3,3 V er logikkforsyning og skal ikke brukes som ISS-forsyning.** En produsent av direkte ISS-grensesnitt dokumenterer 5 V gjennom den fireleder RJ14-kabelen: [Rimik DN V3.2, side 2](https://www.rimik.com/PDF%20file/DN%20V3%202%20Module%20Fact%20Sheet%20Comms%20Rev%20E.pdf). Verifiser kontaktorientering, strømledere og datapar på den faktiske Davis-kabelen før tilkobling; kontaktens lederfarger kan være motsatt av kabelens. Ikke bruk et gjettet RJ11/RJ14-pinnummer. A/B-betegnelser på moduler må sammenholdes med signalpolaritet. Terminering og kabelbeskyttelse må tilpasses den faktiske installasjonen.

## Bygg, drift og oppdatering

1. Velg riktig **Vantage Pro2**-stasjon under **Enheter**.
2. Velg **Kablet ISS – MAX3485, uten konsoll**, og angi RX, DE og /RE.
3. Fyll inn gatewayens IP/DNS, MQTT-port, SSID og Wi-Fi-passord før kompilering. Serveren bygger og signerer firmwaren.
4. Første installasjon kan flashes direkte via nettleserens USB. Senere kan USB eller signert OTA via eksisterende MQTT-forbindelse brukes.
5. Under en OTA-/innstillingstest kreves både riktig ACK og nye seksbytes ISS-meldinger med riktig konfigurasjonshash før endringen kan bekreftes. Normal testfrist, lokal tilbakeføring og omstartsgjenoppretting gjelder også denne profilen.
6. Kontroller målte verdier, feltalder og helse. `ISS_RS485_FRAME` i USB-/MQTT-loggen viser mottatt råramme. Helse viser mottatte byte, godkjente/avviste rammer, UART-feil og overflyt. RSSI fra ISS-radio finnes ikke på en kablet forbindelse; Wi-Fi-signalstyrke er separat.

Gatewayen dekoder seks originale byte fra `source.protocol: "davis-iss-rs485"`. De går gjennom samme kalibrering, beregninger, historikk, værfiler, SQL-kø og godkjente Socket.IO-API som radio. Ingen alternativ klientmåling overstyrer rårammen. Databaseinnstillinger og innstillingslogging endres ikke.

## Verifikasjon

Den faktiske C-driveren er vertsbasert testet med publiserte payload-eksempler, oppdelte leveranser, flere pakker før én poll, støy, avkortede/lange rammer, UART-feil, overflyt, gjenervervet rammegrense og sensortidsavbrudd. Ingen UART-sendeimplementasjon er tilgjengelig i testmodellen. Seksbytesposter inngår også i flashkøens strømbruddstester.

Backendtester dekker alle støttede felttyper, manglende sensorer, regntelleroverløp, restart/gjentakelser, SQL-kø, offentlig datakopi og test/bekreftelse/tilbakeføring. Ekte Mosquitto/mTLS verifiserer seksbytespakkens varige lagringskvittering og avvisning av en ugyldig ramme. OTA-test dekker bytte fra radio til kablet ISS og krever riktig signert utgivelse og hash.

Firmware er kompilert med ESP-IDF 6.1 gjennom nettskjemaet, og signert USB-pakke er kontrollert i nettleseren. **Fysisk ESP32/MAX3485/ISS er ikke tilgjengelig her; flashing, faktisk kabel/polaritet, målesammenligning og strømkutt på målutstyret er derfor ikke utført.** Dette skillet mellom implementert funksjon og fysisk verifikasjon gjelder også radioprofilen.
