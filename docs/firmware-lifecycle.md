# Firmware, identiteter og vedlikehold

Host-bootstrap oppretter én ECDSA P-256-signaturnøkkel per miljø under `secrets/<miljø>/firmware-signing.key` med tilhørende offentlig PEM-fil. Bare den offentlige nøkkelen monteres i control. Privat signaturnøkkel skal oppbevares beskyttet og kan flyttes til frakoblet signeringsmaskin. Behold offentlig fil på hosten og sikkerhetskopier nøklene. Den private enhetsnøkkelen for MQTT er separat og unik per enhet.

Last ned og bevar stasjonens originale enhetspakke. Senere OTA-bygg må beholde den samme stasjonsidentiteten, private enhetsnøkkelen, miljøet og betrodde OTA-nøkkelen. Ny utstedelse av enhetspakke er en ny identitet, ikke ordinær firmwareoppdatering. Ved Secure Boot må appen også bygges/signeres med kortets beholdte RSA-3072-nøkkel og samme sikkerhets-/partisjonsprofil.

Etter bygg:

```sh
node scripts/sign-firmware.js APP.bin STASJONS-UUID production 1.2.0 2 \
  /beskyttet/firmware-signing.key utgivelse.json
```

Sekvens må økes for hver ny test/utgivelse; den er ikke bare et versjonsnavn. JSON-filen inneholder bildet og skal behandles som sensitiv fordi firmware inneholder provisjonering.

Last opp JSON under **Firmware**, velg **Opprett testutkast**, deretter **Test endringen**. Gatewayen distribuerer blokker bare for den aktive testen og riktig stasjon. **Gjør gjeldende** er tilgjengelig først etter kvittering og ferske sensordata fra riktig utgivelse. Ubekreftet test og eksplisitt avbryt gir tilbakeføring; faktisk commit-kvittering fullfører endringen på serveren. Test på én pilot først. Ingen vilkårlig shell er tilgjengelig på ESP32.

## Sertifikatfornyelse

Enhetssertifikat varer 90 dager. Enheten ber om fornyelse når mindre enn 21 dager gjenstår. Control signerer med samme offentlige enhetsnøkkel, og worker leverer over autentisert MQTT. Enheten prøver kandidaten og beholder den først etter vellykket forbindelse/publisering. Den gamle identiteten sperres etter bekreftet overgang; nøkkelen forlater ikke enheten. Langvarig frakoblede eller allerede utløpte enheter trenger lokal gjenoppretting.

Broker- og arbeidersertifikat varer ett år. Kontroller dem på hosten regelmessig:

```sh
node --env-file=PRODUKSJON.env scripts/renew-host-certificates.js
node --env-file=PRODUKSJON.env scripts/renew-host-certificates.js --apply
```

Kjør fra prosjektet eller tilsvarende bootstrap-container med hostdisken montert og `WG_HOST_ROOT` satt riktig. Første kommando er lesekontroll. `--apply` fornyer når mindre enn 30 dager gjenstår og bevarer eksisterende privatnøkler. `WG_PUBLIC_ORIGIN`, `WG_MQTT_SERVER_NAMES`, miljø og OpenSSL må være riktige. CA må fortsatt være gyldig lenge nok; CA-rotasjon er en separat kontrollert prosedyre.

Når resultatet viser fornyede sertifikater, **opprett broker- og worker-containerne på nytt** i Portainer. De individuelle filmonteringene kan fortsatt peke på gammel fil etter atomisk utskifting på hosten; vanlig prosessrestart er utilstrekkelig. Kontroller ny forbindelse og sertifikatutløp etterpå. Planlegg dette som vertsvedlikehold med overvåket resultat. Appen får ikke Docker-socket for å styre verten selv.

Gammel gateway-IP må forbli tilgjengelig mens en ny adresse testes. Sertifikatets SAN må omfatte adressene enheten faktisk bruker. Et IP-bytte omgår aldri CA-/navnekontroll. Sertifikat- og IP-bytte, pakketap rundt commit og strømkutt skal inngå i den fysiske akseptanseprøven.
