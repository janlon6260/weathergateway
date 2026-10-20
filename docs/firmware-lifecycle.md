# Firmware, identiteter og vedlikehold

Førstegangsoppsettet under **Sertifikater** oppretter én ECDSA P-256-signaturnøkkel per miljø under `secrets/<miljø>/firmware-signing.key` med tilhørende offentlig PEM-fil. Privatnøkkelen er bare tilgjengelig i control sin sertifikatmappe og kan eksporteres til beskyttet signeringsmaskin. Andre tjenestecontainere får den ikke. Behold offentlig fil på hosten og sikkerhetskopier nøklene. Den private enhetsnøkkelen for MQTT er separat og unik per enhet.

Vanlig firmwarebygg gjøres i **Enheter → Bygg firmware på serveren**. Fyll inn gatewayadresse, MQTT/TLS-port og Wi-Fi, velg USB eller OTA, og start kompileringen. Kontrollserveren beholder stasjonens privatnøkkel og Wi-Fi-passord i et kryptert enhetslager. Den signerer resultatet automatisk. Se [byggtjenesten](firmware-server-builds.md).

Bevar også stasjonens originale enhetspakke beskyttet som sikkerhetskopi. En tidligere klargjort enhet kan importeres én gang i panelet. Senere OTA-bygg må beholde den samme stasjonsidentiteten, private enhetsnøkkelen, miljøet og betrodde OTA-nøkkelen. Ny utstedelse av enhetspakke er en ny identitet. Ved Secure Boot må appen også bygges/signeres med kortets beholdte RSA-3072-nøkkel og samme sikkerhets-/partisjonsprofil; serverbyggerens standardprofil dekker ikke dette.

Alternativt, ved lokal firmwareutvikling, signer et manuelt bygg slik:

```sh
node scripts/sign-firmware.js APP.bin STASJONS-UUID production 1.2.0 2 \
  /beskyttet/firmware-signing.key utgivelse.json
```

Sekvens må økes for hver ny test/utgivelse; den er ikke bare et versjonsnavn. JSON-filen inneholder bildet og skal behandles som sensitiv fordi firmware inneholder provisjonering.

Last opp JSON under **Firmware**, velg **Opprett testutkast**, deretter **Test endringen**. Gatewayen distribuerer blokker bare for den aktive testen og riktig stasjon. **Gjør gjeldende** er tilgjengelig først etter kvittering og ferske sensordata fra riktig utgivelse. Ubekreftet test og eksplisitt avbryt gir tilbakeføring; faktisk commit-kvittering fullfører endringen på serveren. Test på én pilot først. Ingen vilkårlig shell er tilgjengelig på ESP32.

## Sertifikatfornyelse

USB-installasjon direkte i adminpanelet og sanntidslogger via USB/MQTT er beskrevet i [nettleserveiledningen](esp32-browser.md). USB bruker en komplett `.usb-flash.json`-pakke, separat fra OTA-utgivelsen.

Enhetssertifikat har valgfri gyldighet i panelet, inntil 50 år (standard 90 dager), begrenset av CA-ens utløp. Enheten ber om fornyelse når mindre enn 21 dager gjenstår. Control signerer med samme offentlige enhetsnøkkel og samme gyldighetslengde, og worker leverer over autentisert MQTT. Enheten prøver kandidaten og beholder den først etter vellykket forbindelse/publisering. Den gamle identiteten sperres etter bekreftet overgang; nøkkelen forlater ikke enheten. Langvarig frakoblede eller allerede utløpte enheter trenger lokal gjenoppretting.

Broker- og arbeidersertifikater fornyes under **Sertifikater**. Velg varighet og SAN, generer utkast, test og bekreft før gatewayens frist. Nøkler beholdes, og ubekreftede sertifikatendringer tilbakeføres automatisk også etter omstart. Broker og worker overvåker de nye katalogmonteringene og laster endringer automatisk. Appen får ikke Docker-socket. Det tidligere hostskriptet og individuelle filmonteringer er for eldre oppsett; bruk den oppdaterte stacken for administrasjon i panelet.

Se [sertifikatveiledningen](certificates.md) for CA-fornyelse, HTTPS-/DB-eksport, miljøisolasjon og backup. Enheter med gammel CA-kopi må oppdateres før dens utløp selv om CA-nøkkelen beholdes.

Gammel gateway-IP må forbli tilgjengelig mens en ny adresse testes. Sertifikatets SAN må omfatte adressene enheten faktisk bruker. Et IP-bytte omgår aldri CA-/navnekontroll. Sertifikat- og IP-bytte, pakketap rundt commit og strømkutt skal inngå i den fysiske akseptanseprøven.
