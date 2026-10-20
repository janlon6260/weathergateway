# Lokal verifikasjon og produksjonsakseptanse

Lokale tester kjøres i prosjektet, ikke i DockerHub-workflowen. DockerHub bygger og publiserer bare `janlon6260/weathergateway` med miljø `prod` og secret `DOCKERHUB_TOKEN`.

## Verifisert 20. oktober 2026

| Kontroll                                     | Resultat                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Full backendkjøring med native integrasjoner | **128 bestått, 0 feil, 0 hoppet over**                                                                              |
| MariaDB 11.4.13                              | Fire faktiske skjemakopier, NULL-migrasjon, alle felt, Vatne og duplikatvern bestått                                |
| Mosquitto 2.1.2                              | mTLS, IP-SAN, ACL og varig lagringskvittering bestått                                                               |
| React                                        | Produksjonsbygg og Edge desktop/mobil bestått, inkludert nye arbeidsflyter og DB-utkast                             |
| Sertifikatpanel                              | Tom oppstart, CA/MQTT/HTTPS/DB, 50 års gyldighet, mTLS, roller/CSRF, nøkkelbevaring og rollback etter omstart bestått |
| Produksjonsavhengigheter                     | `npm audit --omit=dev`: 0 kjente sårbarheter                                                                        |
| Faktisk køkode i C                           | Kapasitet, 400 poster med omløp, 74 avbrutte skriveposisjoner og checkpoint-/sektorslettingsbrudd bestått           |
| ESP-IDF 6.0.2                                | App 1 049 280 byte; 33 % ledig i hver 1,5 MB OTA-slot                                                               |
| Sikkerhetsprofil                             | ESP-IDF-konfigurasjon og produksjonspartisjonstabell validert; ingen sikkerhetsfirmware flashet eller eFuses endret |

Den siste backendrapporten ligger lokalt i git-ignorert `artifacts/backend-verification.txt`. Testidentiteter og verktøy under `.tools`/`artifacts` inngår ikke i Docker-imaget. Disse resultatene gjelder lokale kontroller, ikke produksjonsgodkjenning av målutstyret.

## Reproduser lokale kontroller

```sh
npm ci
npm test
npm run build
npm audit --omit=dev
```

To integrasjonstester krever lokale kjørbare serverfiler. Sett `WG_MOSQUITTO_BIN` til Mosquitto 2.1.2 og `WG_MARIADB_BIN` til MariaDB 11.4.13 sin `mariadbd` før `npm test`. Uten disse rapporteres testene som hoppet over; det er ikke samme verifikasjonsnivå. Testene oppretter egne data, bruker bare loopback og stopper serverne etterpå. Ingen produksjonslegitimasjon er nødvendig.

På denne maskinen ligger verktøyene i git-ignorert `.tools/verification`. En full kjøring omfatter faktisk mTLS, IP-SAN, stasjons-ACL, gatewayens lagringskvitteringer, fire eksisterende SQL-skjemaer, NULL-migrasjon, utvidede værfelt og gjentakelse etter usikkert commit-resultat. Vertsbasert C-feilinjeksjon finnes i `test/spool-faults.c`; den inkluderer den faktiske firmwarekøens C-kilde og simulerer strømkutt under skriving/sletting/checkpoint.

React er prøvd med Edge på desktop og 390-pikslers mobilvisning. Testadapteren for AD finnes bare i testoppsettet. ESP32 er kompilert med ESP-IDF 6.0.2 og passer i begge OTA-slots; ingen fysisk enhet er flashet. Den sikre førsteprovisjoneringsprofilen krever faktisk revisjonskontroll og beholdte produksjonsnøkler.

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

SQL-migrasjonen er [deploy/sql/20261020-nullable-weather-measurements.sql](../deploy/sql/20261020-nullable-weather-measurements.sql). Produksjonstabeller og eFuses er ikke endret fra denne utviklingsøkten. Ingen tilgjengelig SSH-/Docker-host eller fysisk ESP32 finnes nå; akseptanse på målutstyret gjenstår.
