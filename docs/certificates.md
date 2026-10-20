# Sertifikater i adminpanelet

Åpne **Sertifikater** med en AD-konto i administratorrollen. Utstedelse, nedlasting, testing, bekreftelse og sperring loggføres uten privatnøkler. Andre roller og det offentlige API-et har ikke tilgang til disse operasjonene.

## Første oppstart uten sertifikater

Bruk de oppdaterte `deploy/compose.production.json` / `compose.development.json` og et nytt app-image. Første `prepare`-container oppretter bare datamapper og eierskap, med avslått nettverk. Den avsluttes før ordinære tjenester starter. Den genererer ingen sertifikater. Ingen Docker-socket monteres.

Control oppretter database, brokerkonfigurasjon og offentlig værdatakopi. Adminpanelet starter selv om sertifikatmappen er tom. Broker venter uten å åpne en lytter; worker venter uten MQTT-forbindelse. Offentlig API avviser lesetilgang så lenge lesetoken mangler. Manglende AD-CA stopper ikke prosessen, men LDAPS-innlogging avvises dersom den konfigurerte CA-filen ikke kan leses. AD er fortsatt eneste innloggingsmetode.

AD-CA tilføres separat i `/data/req/weathergateway/secrets/<miljø>/ad-ca.pem`, med eierskap `10001:10001` og modus `0640`. AD-passord kan stå direkte i miljøvariablene som før. Admin nås gjennom den interne HTTPS-proxyen; HTTP-porten er fortsatt bare en intern backend. TLS og sikre cookies deaktiveres ikke for førstegangsoppsett.

Velg **Opprett manglende sertifikater og nøkler**. Angi CA-gyldighet, tjenestesertifikatenes gyldighet og samtlige DNS-navn/IP-adresser ESP32 skal bruke. For denne produksjonen er navnene `wg-api.skrg.no`, `broker`, `172.30.30.100` og `83.243.191.64`. Broker og worker laster identitetene automatisk innen noen sekunder. Eksisterende nøkler/sertifikater overskrives ikke ved denne handlingen.

## Sertifikattyper og gyldighet

| Type | Bruk |
| --- | --- |
| Rot-CA | Miljøets private tillitsanker; CA-nøkkelen finnes bare i control sin sertifikatmappe. |
| MQTT-server | Serveridentiteten på TLS-porten, med DNS- og IP-SAN. |
| MQTT-arbeider | Klientidentiteten `gateway-worker`. |
| HTTPS / reverse proxy | Sertifikat og nøkkel til Apache eller annen TLS-terminering; installeres der separat. |
| Databaseserver | Serveridentitet til en eventuell TLS-aktivert SQL-server; installeres på DB-serveren. |
| Databaseklient | Valgfri klientidentitet hvis SQL-serveren krever gjensidig TLS. |
| ESP32 | Unikt klientsertifikat og privatnøkkel per stasjon, med stasjonsbundet ACL. |

Velg antall døgn eller år. År støttes fra 1 til 50. En tjeneste/enhet utstedes aldri med senere utløp enn CA-en. Hvis CA-en mangler nok gjenværende gyldighet, forkortes utstedelsen til hele døgn innenfor CA-ens utløp; panelet og nedlastingen viser faktisk dato. En CA med mindre enn ett helt døgn igjen må fornyes før ny utstedelse.

Dette er sertifikater fra **egen CA**. De blir ikke automatisk betrodd av nettlesere eller andre klienter. Installer CA som tillitsanker der det er nødvendig. Offentlig betrodde websertifikater må skaffes fra en offentlig CA med dennes grenser; panelet kan ikke utstede et offentlig betrodd 50-årssertifikat. [CA/Browser Forum](https://cabforum.org/working-groups/server/baseline-requirements/requirements/).

## Fornyelse og automatisk tilbakerulling

Velg formål og gyldighet, og trykk **Generer utkast**. Aktive sertifikater endres først ved **Test og aktiver midlertidig**. Kjeden, nøkkelen, gyldigheten og bruksområdet kontrolleres. Tidligere sertifikat og frist lagres før aktivering. Kontroller de faktiske forbindelsene og trykk **Gjør gjeldende** innen fristen, som bruker gatewayens innstilling for bekreftelsestid (standard 300 sekunder). Ubekreftede endringer tilbakeføres også etter omstart. **Gjenopprett forrige sertifikat** tilbakefører straks.

Broker overvåker både ACL og TLS-filer. Endring gir kontrollert omstart og ny autentisering av eksisterende forbindelser. Worker leser nye klientfiler og kobler til på nytt. Katalogmonteringer gjør atomiske filbytter synlige i containerne. Det kreves ikke nye containere for en ordinær fornyelse gjennom panelet. [Mosquitto-konfigurasjon](https://mosquitto.org/man/mosquitto-conf-5.html).

CA-fornyelse beholder eksisterende nøkkel og tillit, og tillates ikke med utløp før allerede utstedte sertifikater. Enheter med en gammel CA-kopi må få fornyet CA før den gamle kopien utløper. Ny utstedelse til ESP32 settes på vent under en CA-endring. Utskifting til en annen CA-nøkkel er en egen migrasjon og gjøres ikke automatisk.

HTTPS og databaseserver kjører utenfor gatewayen. Panelets tilbakeføring gjelder de lagrede sertifikatene, ikke eksterne filer som allerede er kopiert til Apache/SQL. Installer en bekreftet eksport koordinert på den aktuelle serveren.

## Nedlasting, enheter og database

**Generer og last ned enhetspakke** gir `credentials.json` med sertifikat, unik privatnøkkel, CA, firmware-verifikasjonsnøkkel og stasjonens innstillinger. Bruk den med firmwareverktøyet. Privatnøkkelen lagres ikke i gatewayens database. Behold originalpakken beskyttet; en ny utstedelse lager en annen identitet. Automatisk fjernfornyelse gjenbruker enhetens nøkkel og den valgte gyldighetslengden, begrenset av CA-en.

Eksport av tjenesteidentitet er JSON med `certificate`, `privateKey` og `ca` i PEM-format. Disse feltene kan lagres som separate `.pem`/`.key`-filer for Apache/SQL. CA- og firmware-eksport inneholder private nøkler og skal inngå i beskyttet backup. De skal aldri legges i Git eller i offentlig webområde.

Direkte SQL på deres private nett krever fortsatt **ingen DB-sertifikater**. La `WG_DB_CA_FILE`, `WG_DB_CERT_FILE` og `WG_DB_KEY_FILE` stå tomme ved LAN-transport. Ved valgfri TLS kan `WG_DB_CA_FILE=/run/secrets/db-ca.pem` brukes for en separat DB-CA-fil. For databasesertifikater utstedt av gatewayens CA brukes `/run/secrets/client-ca.pem`. Valgfri klientautentisering settes med `/run/secrets/database-client.pem` og `/run/secrets/database-client.key`. De siste to må settes sammen. Endring av miljøvariabler krever ny container; fornyelse av allerede valgte filer skjer dynamisk ved nye SQL-pooler.

## Filer og oppgradering

Control monterer `secrets/<miljø>` skrivbart. Broker får bare `roles/broker`, worker bare `roles/worker` og offentlig API bare `roles/public`, alle lesbart. Disse undermappene forvaltes av control. De skal ikke fylles manuelt. CA- og firmware-privatnøkler publiseres aldri til de andre rollene.

Eksisterende CA/server/worker-filer i samme sertifikatmappe gjenbrukes. Gammel host-bootstrap og individuelle filmonteringer er ikke nødvendig i den nye stacken. Behold miljøets datamapper og nøkler ved oppgradering. Utvikling og produksjon har forskjellige mapper og miljømarkører; sertifikater eller pågående tester promoteres ikke mellom dem.

Ta backup av hele sertifikatmappen sammen med gatewayens kontrollbase. En pågående sertifikattest trenger begge for korrekt tilbakeføring. Automatisk SQLite-backup alene inneholder ikke privatnøkler eller filbaserte sertifikatkopier.
