# Oppgradering 21. oktober 2026

## Egen database for innstillinger

Alle administrasjonsinnstillinger, endringshistorikk, sesjoner, kommandoer, byggmetadata og krypterte passord lagres i MariaDB **weathergateway**, på samme SQL-server som værdatabasene. Utvikling bruker **weathergateway_development**. Værdatabasene mottar bare værdata i eksisterende `wx_data`.

Sett dette i prosjektrotens `.env` eller Portainer-miljøet før oppstart:

```dotenv
WG_CONFIG_DB_HOST=172.29.50.40
WG_CONFIG_DB_PORT=3306
WG_CONFIG_DB_DATABASE=weathergateway
WG_CONFIG_DB_USER=weathergateway
WG_CONFIG_DB_PASSWORD='FYLL_INN'
WG_CONFIG_DB_TLS=false
```

Dette er direkte tilkobling på deres private LAN; DB-CA og VPN er ikke påkrevd. Ved lokal utvikling velges `weathergateway_development`. De genererte stackene velger databasenavn per miljø. Control og worker trenger denne tilkoblingen; public og firmware-builder får ingen SQL-legitimasjon.

Opprett database og dedikert konto med en driftskonto. Begrens kontoen til gatewayens faktiske SQL-klientadresse. Gi `SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER` på `weathergateway.*`, og tilsvarende på utviklingsdatabasen for en separat utviklingskonto. Tabellenes opprettelse krever ingen globale rettigheter. Værskriveren beholder separat `SELECT, INSERT, UPDATE` på de aktuelle `wx_data`-tabellene. Innstillingskontoen trenger ingen tilgang til værdatabasene.

Ved første oppstart migreres eksisterende administrasjonsdata fra den lokale kontrollbasen dersom SQL-konfigurasjonslageret er tomt. Etter vellykket migrering tømmes de lokale innstillingstabellene. SQL er autoritativt; tjenesten starter ikke et alternativt lokalt innstillingslager ved feil. Ta backup av både data- og sertifikatmappen før oppgradering. Selve tilkoblingen til innstillingsdatabasen er oppstartsdata i miljøvariabler.

Automatiske sikkerhetskopier inkluderer en transaksjonell kopi av SQL-innstillingene og den lokale værhistorikken i samme SQLite-backupformat. Det er ikke en distribuert transaksjon mellom MariaDB og SQLite. Offline restore krever samme `WG_CONFIG_DB_*` og stoppede tjenester. Gjenoppretting tar først en sikkerhetskopi av gjeldende innstillinger og værdata, og erstatter SQL-innstillingene transaksjonelt. Bevar sertifikatmappen separat: den inneholder også nøklene `settings-encryption.key`, `weather-db-encryption.key` og `device-vault.key` som trengs for dekryptering.

## Måleverdier og databaselogging

Sanntidslisten beholder siste gyldige verdi per målefelt, også ved sensorbortfall og omstart av gatewayen. Den viser alder per verdi. Grønn gjelder til og med 3 sekunder, oransje over 3 sekunder og rød over 30 sekunder som standard. Tersklene finnes under Innstillinger og kan overstyres per stasjon; ellers arver stasjonen de globale verdiene. Offentlige kompatibilitetsutdata beholder sin eksisterende kontrakt.

Databaser har et globalt pausevalg og eget valg per stasjon, i tillegg til lagringsintervallet per stasjon. Pause stopper både ny kølegging og levering; eksisterende kø beholdes. Bekreftet gjenaktivering fortsetter leveringen. Databasepassord kan nå angis i panelet og lagres kryptert i `weathergateway`; eksisterende miljøvariabler er fortsatt støttet.

Weather Display-skjemaet endres ikke. `NOT NULL DEFAULT 0` beholdes, og manglende målinger bruker tabellens standardverdi. Dette gjelder blant annet manglende lufttrykk. Adminpanelet og intern historikk bevarer at målingen mangler; det gamle SQL-skjemaet kan ikke uttrykke dette skillet. Nullable kolonner får NULL. Ikke kjør den eldre NULL-migrasjonen som del av denne oppgraderingen. UV-kolonnen `davis_vp_uv` brukes bare når den finnes, som i Håhjem-tabellen. Alle feltkoblinger kontrolleres ved tilkoblingstesten.

## Varsling og ESP32-helse

Innstillinger inneholder SMTP-server, valgfri port, ukryptert SMTP, påkrevd STARTTLS eller TLS fra tilkoblingsstart, valgfri innlogging og standardmottakere. Ved privat SMTP-CA kan PEM-kjeden angis. Tilkoblingstest sender ingen e-post; egen testknapp sender en testmelding. Lagrede passord returneres aldri til nettleseren. Lagre utkast, test og bekreft før endringen tas i bruk. TLS-alternativene følger [Nodemailers SMTP-innstillinger](https://nodemailer.com/smtp).

Alarmer inneholder e-postregler for stasjon nede, manglende ESP-kontakt, for gamle værdata, manglende ISS-kontakt, lite ledig minne og tap i ESP-køen. Hver regel kan begrenses til stasjoner og egne mottakere, sekunder/minutter, gjentakelse og melding ved normal drift. Mislykkede leveringer lagres og forsøkes igjen, maksimalt 12 ganger. Utsending skjer etter bekreftede innstillinger. Ved et tapt SMTP-svar etter akseptert levering kan en melding gjentas; samme Message-ID beholdes.

Firmware **2.3.0** sender helsestatus hvert femte sekund: blant annet oppetid, firmware/SDK-versjon, omstartsårsak og antall oppstarter, fri/minste fri heap, største sammenhengende minneblokk, Wi-Fi-signal/kanal, reconnect-tellere, ISS-kontakt/pakkealder og sendekø. Beholdte MQTT-statusmeldinger teller ikke som ny kontakt. Installer ny firmware for å få de nye feltene.

## USB og byggtjeneste

USB-flashing har tidsgrenser og leser alle segmenter tilbake for SHA-256-kontroll. Flash-stubbens avsluttende digest konsumeres før neste segment. Ved avbrutt tilbakeavlesing prøves én ny tilkobling uten ny sletting eller skriving. Etter verifisering starter ESP32, og nettleseren sender en tilfeldig oppstartsutfordring. Bare riktig stasjon, versjon og konfigurasjon gir 100 prosent. Manglende oppstartskvittering gir et tydelig resultat ved 95 prosent og frigjør porten, slik at USB-loggen kan åpnes. Ingen endeløs fremdriftsindikator eller automatisk ny sletting.

GitHub bygger bare app-imaget, parallelt på native amd64/arm64, og publiserer felles tagger først når begge bygg er ferdige. Ingen tester kjøres i workflowen. Byggjobbene har to minutters tidsgrense, manifestjobben ett minutt. Tregt kaldt bygg feiler innen tidsgrensen; runnerkø og DockerHub/nettverk kan ikke tidsfestes eller verifiseres her.

ESP-IDF lastes direkte fra Espressifs offisielle, digest-låste 6.1-image i Portainer. SDK-et bygges eller lastes ikke opp til DockerHub av prosjektets workflow. Firmwarekilder og kontrollerte, låste MQTT/cJSON-kilder følger app-imaget. Prepare-tjenesten publiserer byggmalen. Bruk oppdaterte stacker; en eksisterende custom stack trenger den tredje, lesbare monteringen `system/firmware-builder-runtime:/opt/wg-builder:ro`. Se [byggeoppsettet](firmware-server-builds.md).

Lokalt er database-, SMTP-, nettleser- og ESP-IDF-tester tilgjengelige. Fysisk flashing/radiomottak og drift på deres Docker-host må fortsatt verifiseres på utstyret.
