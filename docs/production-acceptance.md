# Lokal verifikasjon og produksjonsakseptanse

Lokale tester kjøres i prosjektet, ikke i DockerHub-workflowen. DockerHub bygger og publiserer bare `janlon6260/weathergateway` med miljø `prod` og secret `DOCKERHUB_TOKEN`.

## Verifisert 21. oktober 2026

| Kontroll                                     | Resultat                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Full backendkjøring med native integrasjoner | **178 bestått, 0 feil, 0 hoppet over**                                                                                       |
| MariaDB 11.4.13                              | Fire uendrede WD-skjemaer, alle felt, Vatne, pausevalg, sentrale innstillinger og SQL-restore bestått                        |
| Mosquitto 2.1.2                              | mTLS, IP-SAN, ACL og varig lagringskvittering bestått                                                                        |
| React                                        | Produksjonsbygg og Edge desktop/mobil bestått, inkludert nye arbeidsflyter og DB-utkast                                      |
| Sertifikatpanel                              | Tom oppstart, CA/MQTT/HTTPS/DB, 50 års gyldighet, mTLS, roller/CSRF, nøkkelbevaring og rollback etter omstart bestått        |
| Offentlig SQLite-kopi                        | Oppstart uten skriver og uten opprettingsrettigheter, migrasjon fra WAL og videre lesing av nye værdata bestått              |
| Produksjonsavhengigheter                     | `npm audit --omit=dev`: 0 kjente sårbarheter                                                                                 |
| Faktisk køkode i C                           | Kapasitet, 400 poster med omløp, 74 avbrutte skriveposisjoner og checkpoint-/sektorslettingsbrudd bestått                    |
| ESP-IDF 6.1 / firmware 2.4.3                 | Radio 1 092 864 byte, MAX3485 1 092 768 byte; signatur og alle fire USB-segmenter verifisert                                 |
| RFM69-timing og levering                     | Åtte ID-er × 20 simulerte minutter, FIFO-feil, utfall, blokkert forbruker og ekte MQTT med 2,5 s intervall bestått             |
| RFM69-mottakerprofil                         | Justerbar RSSI-trigger, signalfrist, avvist råpakke/AFC, PLL-frist og frekvenskontroll bestått i vertsmodell og kompilering    |
| Tredjeparts-API                              | Administratorgodkjenning, Origin, polling/WebSocket, stasjonsvalg, utløp, nøkkelbytte, tilbakekalling og policyfrist bestått |
| MAX3485 ISS                                  | Faktisk C-kode, UART-feil og rammegrenser, seksbytes værdekoding, varig MQTT-kvittering, SQL-kø og OTA-overgang bestått      |
| Sikkerhetsprofil                             | ESP-IDF-konfigurasjon og produksjonspartisjonstabell validert; ingen sikkerhetsfirmware flashet eller eFuses endret          |

Den siste fullrapporten ligger lokalt i git-ignorert `artifacts/test-results-20261021-rf243.txt`. Den omfatter også ekte MQTT med 2,5-sekunders ISS-intervall. Nettleser- og byggresultater finnes i `artifacts/access-wind-verification.json`, `artifacts/server-build-verification.json` og `artifacts/rs485-build-verification.json`. Testidentiteter og verktøy under `.tools`/`artifacts` inngår ikke i Docker-imaget. Disse resultatene gjelder lokale kontroller, ikke produksjonsgodkjenning av målutstyret. Eierens 2.4.2-logg viser fortsatt RF-feil; forbedring på fysisk radio med 2.4.3 gjenstår å kontrollere.

## Reproduser lokale kontroller

```sh
npm ci
npm test
npm run build
npm audit --omit=dev
```

To integrasjonstester krever lokale kjørbare serverfiler. Sett `WG_MOSQUITTO_BIN` til Mosquitto 2.1.2 og `WG_MARIADB_BIN` til MariaDB 11.4.13 sin `mariadbd` før `npm test`. Uten disse rapporteres testene som hoppet over; det er ikke samme verifikasjonsnivå. Testene oppretter egne data, bruker bare loopback og stopper serverne etterpå. Ingen produksjonslegitimasjon er nødvendig.

På denne maskinen ligger verktøyene i git-ignorert `.tools/verification`. En full kjøring omfatter faktisk mTLS, IP-SAN, stasjons-ACL, gatewayens lagringskvitteringer, fire eksisterende SQL-skjemaer, NULL-migrasjon, utvidede værfelt og gjentakelse etter usikkert commit-resultat. Vertsbasert C-feilinjeksjon finnes i `test/spool-faults.c`; den inkluderer den faktiske firmwarekøens C-kilde og simulerer strømkutt under skriving/sletting/checkpoint.

React er prøvd med Edge på desktop og 390-pikslers mobilvisning, inkludert vindpil/Beaufort, radiodiagnostikk/RSSI-valg og oppretting, nøkkelbytte og tilbakekalling av tilkoblinger. Testadapteren for AD finnes bare i testoppsettet. ESP32 2.4.3 er kompilert med ESP-IDF 6.1 og passer i begge OTA-slots; ingen fysisk enhet er flashet her. Den sikre førsteprovisjoneringsprofilen krever faktisk revisjonskontroll og beholdte produksjonsnøkler.

## Gjennomfør på målutstyret

| Prøve                 | Konkret godkjenningsgrunnlag                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker/Portainer      | Begge miljøer starter med riktig image/digest. Hostdisken er montert, alle tjeneste-UID-er har bare nødvendige rettigheter, og data overlever omstart. Worker, MQTT og offentlig datakopi fungerer.          |
| Nettisolasjon         | Fra et faktisk eksternt IPv4- og IPv6-nett er admin, admin-API og private porter utilgjengelige. Internnett/VPN når riktig HTTPS-adresse. Bare MQTT/TLS og lese-API er publisert som planlagt.               |
| AD                    | Nestede rollegrupper, leser/operatør/admin, sperret bruker, rolleendring, DC-bortfall og CA-/navnefeil prøves uten svekket TLS.                                                                              |
| Davis/ESP32           | Alle fire stasjoners sender-ID, modell, 868 MHz-radio, mm/vipp, posisjon og vindmålerhøyde er kontrollert. Sammenlign flere døgn med Davis/WD, inkludert regn og høye/lave verdier.                          |
| Feil og tilbakeføring | Feil gateway-IP/port/sertifikat, ingen SNTP, frakobling, strømkutt under NVS/OTA/commit, full sendekø og tapte kvitteringer gir forventet lokal tilbakeføring og synlig datakvalitet.                        |
| Maskinvaresikkerhet   | Faktisk ESP32-revisjon er registrert. Pilotkort er førstprovisjonert med egnet sikkerhetsprofil og beholdte nøkler. Secure Boot, flash- og NVS-kryptering bekreftes av enheten og ved fysisk test.           |
| SQL-overgang          | Ordinær SQL-backup er tatt, NULL-migrasjonen er kjørt kontrollert, begrenset skrivekonto prøvd, gammel skriver stoppet per stasjon og nye rader kontrollert. Utvikling kan ikke skrive produksjonsdatabaser. |
| Gjenoppretting        | Gjenopprett SQLite, kø, nøkler, enhetsidentiteter og øvrige filer på isolert kopi. Gamle tester/kommandoer kan ikke gjenaktiveres. Kontroller ny offentlig datagenerasjon.                                   |
| Kompatibilitet        | Sunnmørsværs faktiske filer/Socket.IO-hendelser og de avtalte WD-rapportene sammenlignes med innganger, avrunding, manglende data og tidszoner.                                                              |
| Langtidsdrift         | Nettutfall, leveringskø, diskforbruk, radio, sertifikatfornyelse, hostsertifikatvedlikehold og backupvarsling observeres over en avtalt prøveperiode.                                                        |

Registrer faktisk utførelse/resultat i **Produksjonsstatus**. Manuelle oppføringer er knyttet til bekreftet konfigurasjon, aktør og tidspunkt og utløper etter 30 dager eller endret konfigurasjon. En manuell oppføring kan ikke overstyre manglende sensordata, SQL-levering, enhetsrapportert sikkerhet eller arbeiderpuls.

Den tidligere NULL-migrasjonen skal ikke kjøres ved denne oppgraderingen; opprinnelige Weather Display-skjemaer beholdes. Se [oppgraderingen](operations-20261021.md). Produksjonstabeller og eFuses er ikke endret fra denne utviklingsøkten. Ingen tilgjengelig SSH-/Docker-host eller fysisk ESP32 finnes nå; akseptanse på målutstyret gjenstår.

Firmware 2.4.3 er kompilert gjennom serverbyggingen for både radio og kablet ISS / MAX3485, med signatur og alle fire USB-segmenter kontrollert. Nye SMTP-/varselskjemaer, beholdte værverdier, feltalder, radiodiagnostikk/RSSI-valg og verktøyfaner er også prøvd i Edge på desktop og mobil. Fysisk USB-kvittering og Docker-drift er fortsatt ikke tilgjengelig for verifisering her. Kablet ISS har en full værdatadriver, men faktisk strømforsyning, kabel/polaritet og målesammenligning må fortsatt prøves på målutstyret. Se [MAX3485-veiledningen](davis-rs485.md).
