# WeatherGateway – sertifikatpakke for __ENVIRONMENT__

Dette er en isolert førstegangsprovisjonering, ikke en utskifting av eksisterende CA. Pakken inneholder private nøkler og skal oppbevares beskyttet. Ingen DB- eller AD-sertifikater er inkludert. Servernavnene er: __SERVER_NAMES__.

## Innhold

- `secrets/__ENVIRONMENT__/`: CA, brokerens serveridentitet, workerens klientidentitet, ECDSA-nøkler for OTA og lesetoken. Behold backup av CA- og signaturnøkler. Bare den offentlige firmware-nøkkelen monteres i control.
- `provisioning/__ENVIRONMENT__/stations/<UUID>/`: unik enhetsidentitet og `credentials.json` per ESP32. Disse mappene skal ikke monteres i applikasjonscontainerne. Innstillingene er opprinnelige prosjektstandarder; kontroller sender-ID, GPIO og tilkoblingsadresse mot bekreftede panelinnstillinger før flashing.
- `__ENVIRONMENT__/system/certificate-import/`: offentlig register og importverktøy for gatewayens eksisterende kontrollbase og ACL. Eksisterende konfigurasjon, historikk og sperringer erstattes ikke.
- `CERTIFICATES.json`: fingeravtrykk, navn og utløp uten private nøkler.

## Installasjon

1. Kontroller riktig montert disk på `/data/req/weathergateway`. Pakk ut i en beskyttet midlertidig mappe, ikke over eksisterende produksjonsdata.
2. Finnes det allerede en annen CA på hosten, skal denne pakken ikke erstatte den. Installeringsskriptet avbryter hvis en eksisterende målfil har annet innhold.
3. Kjør `sudo sh install-first-provisioning.sh` fra pakkens rot. Ingen eksisterende identitet overskrives.
4. Kjør ordinært host-bootstrap med `WG_ENVIRONMENT=__ENVIRONMENT__`, `WG_PUBLIC_ORIGIN=__PUBLIC_ORIGIN__` og de faktiske admin-/AD-innstillingene. Bootstrap gjenbruker installerte nøkler og klargjør broker og datalager. AD-CA tilføres separat. Ingen DB-/AD-sertifikater genereres av dette.
5. Start riktig Portainer-stack. Registrer deretter enhetsidentitetene med faktisk control-containernavn:

```sh
docker exec -u 10001:10001 NAVN_PA_CONTROL_CONTAINER \
  node /data/system/certificate-import/import-device-certificates.mjs \
  /data/system/certificate-import/device-certificates.json
```

Importen kontrollerer CA, miljø, stasjon, signatur, gyldighet og bruksområde. Den er gjentakbar og gjenåpner ikke sperrede sertifikater. Ikke utsted nye enhetsidentiteter fra panelet hvis du vil beholde akkurat nøklene i pakken.

Ved direkte IP-tilkobling må faktiske adresser stå i IP-SAN. Ikke deaktiver sertifikat-/navnekontroll. Apache/HTTPS og fysisk Secure Boot-provisjonering er separate oppgaver; pakken er ikke et offentlig betrodd websertifikat.
