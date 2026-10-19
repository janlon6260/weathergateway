# Leveransestatus

Arbeidet er byttet fra den første Python-kjernen til Node/Express og React. Server, frontend, utplassering og firmware ligger i samme prosjekt. Dette dokumentet skiller implementasjon fra verifikasjon; en grønn enhetstest betyr ikke at en fysisk stasjon eller produksjonsinstallasjon er godkjent.

## Implementert og lokalt kontrollert

Verifisert 19. oktober 2026: **75 av 75 backendtester passerte**, React-produksjonsbygg passerte og adminpanelet er prøvd i WebKit på desktop/mobil. RF-enhetsskjemaet er også nettleserprøvd, med sender-ID som utkast uten påvirkning av aktiv konfigurasjon. ESP32-firmwaren med RFM69HCW-driver er kompilert med ESP-IDF 6.0.2, Espressif MQTT 1.1.0 og cJSON 1.7.19~2. Testbygget er **1 025 504 byte** og har 35 % ledig plass i hver app-partisjon på 1,5 MB. Bygget bruker midlertidige utviklingsnøkler for `.invalid`-domene og er ikke produksjonsfirmware. Ingen fysisk enhet er flashet.

- Express-kontrollplan, React-panel, innlogging og roller med en LDAPS-klient som kontrollerer CA og servernavn. AD-protokolltilfeller er testet med kontrollert klient/testadapter. Reell TLS-forbindelse til organisasjonens AD er prøvd med en betrodd CA fra Windows og godkjent med navnekontroll. Servicebind ble avvist med LDAP 49; reell brukerinnlogging og roller er derfor ikke godkjent. CA-/kontoinnstillinger må holdes riktige i målmiljøet.
- Mellomromstolerante CIDR-/LDAPS-lister, konkret AD-feilkode uten rå LDAP-meldinger i loggen og ingen automatisk gjentakelse av feil servicelegitimasjon mot flere domenekontrollere. Ubrukt utviklingsoppsett kan korrigere AD-verdiene fra `.env` før første innlogging; bekreftet oppsett og produksjon overskrives ikke.
- Stasjonsadministrasjon, sanntidsutvalg, gateway-/enhetsutkast, test, bekreftelse, femminuttersfrist, CAS og gjenoppretting ved omstart/klokkefeil.
- MQTT-payloadvalidering, CRC-dekoding, duplikater, sen ankomst, sensorkontakt, enheter, eksport, aggregater og sommertidsgrenser.
- Direkte europeisk ISS-radio via Adafruit RFM69HCW, femkanalshopping, sender-ID, RSSI, råpakker, egen måletid/utløp per felt og vedvarende syvbits regnteller. Backendprøver inkluderer publiserte temperatur-/fuktpakker, korrupsjon, feil ID, feil GPIO, kandidatkvittering, gjenoppstart og døgnskifte. [Fysisk radioprøve](davis-radio.md) gjenstår. Lufttrykk står etter avtale som manglende.
- Meteorologiske metoder listet i beregningskatalogen og astronomi med en versjonert bibliotekavhengighet.
- Sunnmørsvær-hendelsene `file-content`, `get_trends`, `trend_snapshot`, `trend_update`, `fetch24HourTrend`, `fetchTrendData` og `trendData`. Socket-test bruker faktisk Socket.IO-server og klient med lesetoken.
- Reell sertifikatutstedelse via OpenSSL, klient-EKU, stasjonsbundne MQTT-tilganger og sperring. Selve Mosquitto-håndhevingen trenger container-/nettverkstest.
- Konsistent SQLite-backup, SHA-256, integritetstest av kopien, retensjon og separate offentlige værdata uten AD/sesjoner/kommandoer.
- Frontend bygget og nettleserprøvd med kontrollert AD-adapter, inkludert opprettelse/test/bekreftelse og mobilvisning. Ingen testinnlogging følger den deploybare applikasjonen.

## Må gjennomføres i målmiljøet

1. Bygg og start begge Docker-stackene; kontroller volumrettigheter, helsesjekker, Mosquitto, TLS, nettverk, minnebruk og omstart. Docker/Portainer finnes ikke på denne arbeidsmaskinen.
2. Sett LDAPS-verdier og AD-CA. Prøv reelle nestede grupper, sperret bruker, CA-/navnefeil, utilgjengelig DC og rolleendring. Ingen passord trengs i chatten.
3. Bygg med stasjonens faktiske enhetspakke og prøv på fysisk ESP-WROOM-32 og Adafruit RFM69HCW. Direkte ISS og 868 MHz er avklart. Kompilerings- og partisjonskontroll er utført; dette bekrefter ikke faktisk kobling, radiorekkevidde eller frekvenslåsing. Kontroller sender-ID og regnkalibrering. CP2102 er USB-seriebrikken og angir ikke ESP-silisiumrevisjonen.
4. Prøv strømkutt og tap av forbindelse under test, commit og rollback, inkludert feil gatewayadresse og sertifikat, feil klokke og full disk. Kryssjekk sensortall mot Davis og WD.
5. Prøv endelig Apache2/DNS/hostbrannmur fra både VPN og et eksternt nett. Adminruter og adminporter skal være utilgjengelige eksternt. Apache2-arbeidet er utsatt etter avtale.
6. Test gjenoppretting på isolert kopi, nøkkelbackup, sertifikatfornyelse og langtidsbelastning. Fil- og hendelsesformat er undersøkt i kildekoden; full sammenligning mot levende WD-eksporter gjenstår.

## Funksjoner som fortsatt mangler før hele bestillingen er oppfylt

- Komplett Weather Display-paritet: øvrige beregninger som ET/graddager, avansert vind-/regnstatistikk, ekstra sensorer, alarmregler, alle rekordperioder, rapport-/malformater, historikkimport og eventuelle lokale WD-verktøy. Den konkrete matrisen er i `weather-display-scope.md`.
- ESP32 har foreløpig ingen implementert firmware-nedlasting/OTA-distribusjon eller fjernfornyelse av klientsertifikat. Oppstartskontrollen for en OTA-partisjon er ikke et komplett oppdateringssystem.
- ESP32 har foreløpig ikke varig mellomlager og senere tilbakesending av målinger under internettbrudd. Dermed er ubrutt historikk ved nettutfall ikke levert.
- ISS-radioens oppstartssøk, hopping, RF-dekoding og rollback trenger fysisk verifikasjon mot de faktiske Vue-/Pro2-stasjonene. ISS-repeatere, USB-host og WeatherLink IP er ikke implementert; disse er ikke valgt som prosjektets datavei.
- Secure Boot, flash-/NVS-kryptering og eFuse-provisjonering er ikke aktivert eller fysisk verifisert. Vanlig firmwarelagring beskytter ikke private nøkler ved fysisk uttrekk. WROOM-navnet alene er ikke tilstrekkelig grunnlag for irreversible eFuse-valg.
- Netatmo er utsatt etter avtale.

Disse hullene er utviklingsarbeid og testarbeid. De skal ikke presenteres som innstillinger som bare mangler i `.env`, og systemet skal ikke omtales som ferdig produksjonsklart før de er håndtert.
