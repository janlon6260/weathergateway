# Docker / Portainer

Bruk en Linux-host med lokal disk montert på `/data/req/weathergateway`. Docker/Portainer er ikke installert på utviklingsmaskinen; oppsettet må prøves i utviklingsmiljø før produksjon.

## Miljøfil

Kopier `deploy/development.env.example` eller `deploy/production.env.example` til `.env` på hosten. Fyll inn privat host-IP, AD-FQDN, Base DN, bind-DN og eksisterende AD-grupper. Rollene er `administrator`, `operator` og `viewer`. Gruppetilknytning er JSON; legg gjerne til forventet gruppe-SID. Ved direkte innliming i Portainers variabelfelt skal de ytre enkle sitattegnene fra `.env`-eksemplet utelates.

AD-bindpassordet kan legges direkte i `.env` som `WG_LDAP_PASSWORD='ditt_passord'`. Bruk sitattegn rundt verdien for å bevare blant annet `#` og mellomrom. En ikke-tom `WG_LDAP_PASSWORD` har prioritet over `WG_LDAP_PASSWORD_FILE`; når verdien er tom eller mangler, brukes passordfilen hvis den er konfigurert. Bare kontrolltjenesten får AD-passordet i Docker-stackene. Ved innliming direkte i Portainers variabelfelt skriver du selve passordet uten ytre sitattegn.

`WG_TRUSTED_PROXIES` må være de faktiske proxyadressene sett av containeren; Docker/NAT kan gjøre at Apache fremstår som bridge-gatewayen. `WG_ADMIN_CIDRS` skal bare omfatte de interne nett/VPN som skal ha tilgang. Ikke stol på vilkårlig `X-Forwarded-For` eller hele internett.

Første oppstart bruker `.env` til initialisering. I utviklingsmiljøet kan AD-verdiene korrigeres i `.env` frem til første vellykkede innlogging, så lenge gatewayen fortsatt har revisjon 1 og ingen gatewayendring er opprettet. Bare AD-delen synkroniseres ved restart, og dette logges i audit. Dette gjør at et første feilforsøk ikke låser inn eksempelverdier. Etter innlogging eller en gatewayendring styres vedvarende innstillinger gjennom panelet; en endret seedverdi i `.env` overskriver da ikke bekreftet konfigurasjon. Produksjon synkroniserer aldri en allerede opprettet gateway fra `.env`. AD-passord leses ved prosessoppstart; AD-CA leses når en katalogforbindelse opprettes. I Docker må en container opprettes på nytt når miljøvariabler endres.

Mellomrom rundt kommaseparerte oppføringer i `WG_ADMIN_CIDRS`, `WG_TRUSTED_PROXIES` og `WG_LDAP_URLS` fjernes før validering. Dermed er eksempelvis `127.0.0.0/8, ::1/128, 172.29.80.0/24` gyldig uten å tillate offentlige nett.

Ved `503` under AD-innlogging viser backendterminalen `directory_connection_failed` med domenekontroller, fase og en begrenset feilkode. `UNABLE_TO_VERIFY_LEAF_SIGNATURE` betyr at sertifikatkjeden ikke kan bekreftes med valgt CA-fil. Kontroller at filen inneholder riktig organisasjons-CA i PEM-format og at LDAPS-navnet matcher sertifikatet. [Microsofts krav til LDAPS-sertifikater](https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/enable-ldap-over-ssl-3rd-certification-authority). En vellykket TLS-forbindelse bekrefter ikke brukernavn/passord: `LDAP_49` i fasen `service_bind` betyr at AD avviser servicekontoens bind. Kontroller `WG_LDAP_BIND_DN` og passordet i `WG_LDAP_PASSWORD`, eventuelt filen `WG_LDAP_PASSWORD_FILE`. Logger videresender ikke passord, bind-DN eller rå LDAP-feilmeldinger; kjente AD-underkoder kan følge med. Feil servicelegitimasjon prøves ikke automatisk mot flere domenekontrollere.

## Image og DockerHub-workflow

Prosjektet bruker ett eget image: `janlon6260/weathergateway`. Express serverer den ferdigbygde React-frontenden. Det samme imaget kjøres i tre separate containere med `WG_ROLE=control`, `worker` og `public`; hver har egne nettverk, datatilganger og hemmeligheter. Mosquitto bruker det offisielle `eclipse-mosquitto`-imaget. Det trengs ingen egne `weathergateway-frontend`-/`weathergateway-backend`-repositoryer i DockerHub.

[`.github/workflows/dockerhub.yml`](../.github/workflows/dockerhub.yml) bygger og publiserer bare Docker-imaget. Workflowen kjører ikke tester, lint eller sikkerhetsskanning, og starter ikke Portainer-stackene. Dockerfile kjører heller ikke `npm test`; testene kjøres lokalt. React-kompileringen er en nødvendig del av imagebygget.

GitHub-jobben bruker environment **`prod`**, DockerHub-bruker **`janlon6260`** og environment-secret **`DOCKERHUB_TOKEN`**. Tokenet må gi skrivetilgang til `janlon6260/weathergateway`. Det brukes bare ved DockerHub-innlogging, ikke som build-argument. Ingen ekstra secret for brukernavn kreves. Environment-secrets er tilgjengelige for jobber som peker på det aktuelle miljøet. [GitHubs dokumentasjon](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

| Utløser                                                       | DockerHub-tagger                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Push til `main`                                               | `latest`, `main`, `sha-<full commit-SHA>`                           |
| Versjonstagg, for eksempel `v1.2.3`                           | `1.2.3`, `1.2`, `sha-<full commit-SHA>`                             |
| Manuelt via **Actions → Publish Docker image → Run workflow** | Tagger for valgt branch/versjon og commit; `latest` bare for `main` |

Imaget bygges for `linux/amd64` og `linux/arm64`. Docker-actions er låst til konkrete commit-SHA-er. Oppsettet følger [Dockers veiledning for bygg og publisering](https://docs.docker.com/build/ci/github-actions/push-multi-registries/) og [metadata/tagger](https://docs.docker.com/build/ci/github-actions/manage-tags-labels/). Kjøringen publiserer bare til DockerHub og laster ikke opp build-record-artifakter til GitHub.

## Hent image og klargjør disk

Etter første vellykkede workflow-kjøring, på Portainer-hosten:

```sh
docker pull janlon6260/weathergateway:latest
```

Miljøeksemplene bruker `WG_IMAGE=janlon6260/weathergateway:latest`. Sett en publisert `sha-...`-tagg eller et konkret digest når installasjonen skal låses til ett bestemt bygg. Begge miljøer kan bruke samme image med ulike innstillinger og datamapper; sett `WG_IMAGE` separat for å prøve et nytt bygg i utvikling før produksjon. Stacken bygger ikke kildekode i Web editor. Et lokalt image kan fortsatt bygges med `docker build --pull -t janlon6260/weathergateway:local .`.

Kontroller at riktig disk er montert. Den oppdaterte stacken kan startes uten sertifikater og trenger ikke host-bootstrap. En kort `prepare`-jobb klargjør mapper/eierskap uten nettverk og avsluttes før ordinære tjenester. Control lager database, offentlig værdatakopi og brokerkonfigurasjon. Broker og worker venter på sertifikater; ingen ukryptert MQTT-lytter opprettes.

Logg inn gjennom intern HTTPS-proxy og åpne **Sertifikater**. Velg gyldighet inntil 50 år, angi DNS-navn/IP-adresser, og opprett CA, MQTT-identiteter og firmware-nøkler. Eksisterende nøkler beholdes. Se [sertifikatveiledningen](certificates.md) for førstegangsoppsett, fornyelse, automatisk tilbakerulling og eksport til HTTPS/SQL.

Legg følgende filer under `/data/req/weathergateway/secrets/<miljø>`:

| Fil                      | Innhold                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `ldap-password`          | Valgfritt alternativ til `WG_LDAP_PASSWORD`. Kan utelates ved direkte passord. |
| `ad-ca.pem`              | Organisasjonens CA-kjede for domenekontrollerne i PEM. Dere tilfører denne.                        |
| `read-token`             | Tilfeldig generert lesetoken for Sunnmørsværs backend.                                             |
| `client-ca.key` / `.pem` | Miljøets PKI; privat CA-nøkkel monteres bare i kontrolltjenesten.                                  |
| `server.key` / `.pem`    | Brokerens TLS-identitet med offentlig MQTT-navn og `broker` i SAN.                                 |
| `worker.key` / `.pem`    | MQTT-arbeiderens klientidentitet.                                                                  |

AD-bindpassordet kan settes i `.env` eller Portainers miljøvariabler som beskrevet over. Private nøkler og øvrige hemmeligheter monteres som filer. `.env` er utelatt fra både Git og Docker-byggkonteksten. Normal UID er 10001/GID 10001; offentlig API har UID 10002/GID 10001, broker UID 1883/GID 10001. CA- og arbeidernøkler er 0400; brokerens servernøkkel er 0440 for felles GID. AD-filene skal bare kunne leses av nødvendig tjenestebruker.

## Stack og nettverk

For ekstern værdatabaseskriving: sett `WG_DB_ALLOWED_DATABASES` og `WG_DB_PASSWORD` separat per miljø, og konfigurer stasjonene under **Databaser**. La `WG_DB_CA_FILE` stå tom ved LAN eller offentlig betrodd DB-CA. Ved en separat privat DB-CA legges `db-ca.pem` i sertifikatmappen og `WG_DB_CA_FILE=/run/secrets/db-ca.pem` settes. Bare control og worker får databaselegitimasjon og DB-CA-filen. Se [databaseveiledningen](weather-database.md) for skjema, TLS, kø og samordnet overgang fra eksisterende skriving.

Gatewayen og SQL-serveren står på samme private nett. Sett `WG_DB_LAN_ENDPOINTS` til de eksakte private vert:port-målene og velg **Privat lokalnett (uten TLS)** per stasjon; dette er standard for nye koblinger. Verdien videresendes bare til control og worker. Denne forbindelsen krever verken TLS eller VPN. TLS med sertifikatkontroll kan velges dersom databaseserveren tilbyr det.

Opprett én stack per miljø med `deploy/compose.development.json` og `deploy/compose.production.json`. JSON er gyldig Compose/YAML. Angi variablene fra riktig miljøfil. Datastier, miljø og hemmelighetsmapper er forskjellige, bokstavelige verdier i stackene.

Admin bindes til privat `WG_ADMIN_BIND_IP`:18091/18081. Lese-API bindes til host-loopback:18090/18080 for Apache. MQTT åpnes separat som TCP 8884/8883 med mTLS; vanlig HTTP ProxyPass frakter ikke rå MQTT. Apache2-konfigurasjonen gjøres senere som avtalt.

Admin skal ha privat DNS/ruting/VPN og ingen offentlig portvideresending eller Apache-vhost. Test IPv4 og IPv6 fra eksternt nett. Applikasjonens nettverkskontroll erstatter ikke hostbrannmur; Docker-portpublisering må inngå i testen.

Når Apache kjører på samme host, bruk helst 127.0.0.1 som adminbinding og la bare den interne HTTPS-vhosten være inngang. Hvis Apache står på en annen host, må forbindelsen mellom proxy og backend beskyttes med kryptert transport og brannmur begrenset til proxyen. De genererte Node-tjenestene bruker HTTP på innsiden; ekstern TLS-terminering og eventuell kryptering mellom hoster må derfor være på plass før innlogging tas i bruk. Proxyen må bevare riktig opprinnelig vertsnavn og bare betrodde forwarding-headere.

Den offentlige tjenesten får bare `<miljø>/public` montert lesbart. Den får ikke kontrollbasen eller AD-/enhets-/CA-nøkler. Ingen tjeneste får Docker-socket, privilegert modus eller root ved normal drift.

## Første innlogging og enheter

Logg inn med en AD-konto i konfigurert administratorgruppe. Kontroller Skodje, Håhjem, Longva og Vatne mot faktisk installasjon: modell, posisjon og mm per regnvipp. Standardene er hentet fra det eksisterende Sunnmørsvær-prosjektet.

Utsted en unik enhetspakke under **Sertifikater**, velg gyldighet og følg `firmware/README.md`. Privatnøkkelen leveres én gang og lagres ikke i databasen. Utviklings- og produksjonssertifikater er ikke ombyttbare.

Enhetssertifikater har valgfri gyldighet inntil 50 år (standard 90 dager) og fjernfornyes når mindre enn 21 dager gjenstår. Server/arbeider og CA har også valgfri gyldighet. Forny dem i **Sertifikater** med test/bekreftelse. Katalogmonteringer og overvåking av sertifikatfiler gjør at broker/worker laster endringer uten nye containere. Se [OTA og sertifikatvedlikehold](firmware-lifecycle.md).

## Sikkerhetskopi og restore

Control lager konsistente databasekopier i `<miljø>/system/backups` med miljø, status, tidspunkt og SHA-256. Standard automatisk intervall er 24 timer, og de 30 siste fullførte kopiene beholdes. Begge innstillinger styres i panelet med test/bekreftelse; intervall 0 deaktiverer planen. Mislykkede forsøk gjentas tidligst etter én time. Databasen inneholder også rårammene. Nøkler, firmwarebilder, JSONL og øvrige filer må inngå i separat, beskyttet hostbackup. Ekstern/offsite backup må settes opp på verten.

Prøv gjenoppretting på en isolert kopi først. Ved reell restore: stopp alle fire tjenester, behold diskbackup og bruk UUID fra backuplisten:

```sh
docker run --rm --user 10001:10001 --env-file .env \
  -e WG_DATA_ROOT=/data -e WG_OFFLINE_RESTORE=services-stopped \
  -v /data/req/weathergateway/production:/data \
  janlon6260/weathergateway:latest node scripts/restore-backup.js BACKUP-UUID
```

For utvikling brukes utviklingsmappen og miljøfilen. Verktøyet verifiserer SHA-256, integritet og miljø og tar en ekstra kopi av gjeldende database. Det kan ikke bevise at operatøren faktisk har stoppet andre prosesser; kjør det aldri mot aktiv stack. Sesjoner slettes, uferdige tester tilbakeføres og gamle kommandoer kanselleres. Kommandosekvensen økes for å unngå replay etter eldre snapshot. Faktiske enhetsinnstillinger må avstemmes før normal drift.

Restore bytter datakopiens generasjons-ID. Ved neste oppstart tømmer arbeideren den offentlige værdatakopien og bygger den på nytt, slik at nyere cachedata fra før restore ikke beholdes. Ikke slett hoveddatabasen, hemmelighetene eller stasjonsarkivet. Hostbackup og rollback-/nettverksfeil må inngå i akseptansetesten.
