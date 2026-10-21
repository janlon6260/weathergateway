# Direkte kablet ISS via MAX3485

Brukeren har valgt kablet Vantage Pro2 ISS uten Davis-konsoll og en **3,3 V MAX3485**. En vanlig MAX485 er en 5 V-komponent; den skal ikke kobles direkte til ESP32s RX uten egnet nivåtilpasning. Se produsentens [MAX3485](https://www.analog.com/en/products/max3485.html) og [MAX485](https://www.analog.com/en/products/max485.html).

**Den direkte, kablede ISS-protokollen er ennå ikke verifisert. Profilen som er implementert nå, er mottaksopptak og diagnostikk, ikke en ferdig værdatadekoder.** Den eksisterende WeatherLink-driveren er for konsollens LOOP/LOOP2-grensesnitt og brukes ikke på ISS-bussen. Det er heller ikke antatt at kablede ISS-rammer har samme format eller CRC som radiopakkene.

## Bygg og flash opptaksfirmware

1. Velg riktig Vantage Pro2-stasjon under **Enheter**.
2. Under **Bygg firmware på serveren**, velg **Kablet ISS – MAX3485, opptak og diagnostikk** som maskinvare og datakilde.
3. Angi RX, DE og /RE-pinner samt en UART-hastighet som skal undersøkes. Forvalgt 19200 baud er et diagnostisk startvalg, ikke en bekreftet Davis-protokollspesifikasjon. De øvrige valgene er 1200, 2400, 4800, 9600 og 38400; opptak bruker 8N1.
4. Angi gatewayadresse, MQTT-port og Wi-Fi som vanlig. Bygg og flash med USB. Opptaksprofilen tilbys ikke som OTA-test, siden den ikke produserer gyldig værtelemetri som kan godkjenne en slik test.
5. Åpne USB-logg eller sanntidslogg via MQTT. Linjer som begynner med `ISS_RS485_CAPTURE` inneholder baudrate, byteantall og rådata i heksadesimal form. Helsepanelet viser mottatte byte, UART-feil, overflyt og eventuelle utelatte byte.

Standard GPIO-oppsett for MAX3485-siden:

| MAX3485 | ESP32                                                          |
| ------- | -------------------------------------------------------------- |
| VCC     | 3,3 V                                                          |
| GND     | GND                                                            |
| RO      | GPIO16                                                         |
| DE      | GPIO25, holdes lav                                             |
| /RE     | GPIO26, holdes lav under mottak                                |
| DI      | Ingen ESP32-TX tilkoblet; hold inngangen på definert lavt nivå |

Driveren konfigurerer ikke UART-TX eller automatisk senderstyring og sender ingen bytes/kommandoer. DE holdes lav også ved stopp. Sørg for ekstern pulldown på DE, slik at senderen også er deaktivert under reset og før fastvaren har konfigurert GPIO. Start, feilbehandling, rådata og buffergrenser er prøvd med den faktiske C-koden mot en maskinvaremodell, i tillegg til ekte ESP-IDF-kompilering. Fysisk utstyr er ikke testet her.

MAX3485 omsetter signalnivåer og forsyner ikke ISS med strøm. Uten konsoll må korrekt separat ISS-strømforsyning, RJ11-pinout og busstilkobling avklares for den faktiske ISS-modellen før tilkobling. Ikke koble ESP32s 3,3 V direkte til ISS-strømpinnen på bakgrunn av modulens forsyningsspenning. A/B, felles referanse og eventuell terminering må verifiseres på den faktiske kabelen; ingen udokumentert RJ11-kobling er foreslått her.

## For å ferdigstille værdatadriveren

Det trengs et verifiserbart rammeformat og kontrollsum, fra dokumentasjon eller reelle opptak sammenholdt med referansemålinger. Eksempel på tidligere gjennomført direkte ISS/ESP32-arbeid finnes hos [Zachs opprinnelige prosjektbeskrivelse](https://blog.awszac.com/2021/09/17/davis-vantage-pro-2-open-weather-station-part-9-back-in-the-saddle/). Forfatteren lenker til et kodeeksempel på WXForum, men koden kunne ikke leses gjennom nettstedets nettleserverifisering i denne økten. Brukeren har bekreftet at egen kode/dokumentasjon ikke finnes.

Inntil protokollen er verifisert, er sensorkontakt og værproduksjon deaktivert for denne profilen. Produksjonskontrollen godkjenner den heller ikke som verifisert værdataprofil. Eksisterende radioprofil og konsollens WeatherLink-driver fortsetter som før. Lufttrykk for direkte ISS er fortsatt manglende som avtalt.
