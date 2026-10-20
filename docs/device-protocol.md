# MQTT og enhetsstyring

Kontrakten er implementert i `server/schema.js`, `server/worker.js` og `firmware/main`. Fysisk tilkobling og bygg står i `firmware/README.md`. Dette er gatewayens interne protokoll; Sunnmørsværs eksisterende kontrakt ivaretas av egne adaptere.

Rot: `wg/v1/<production|development>/stations/<station-uuid>/`. Hvert miljø har egen broker og CA.

| Emne                                 | Enhet                                              | Gatewayarbeider                               |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------- |
| `telemetry`                          | Publisere, QoS 1, ikke retained                    | Lese                                          |
| `acks`                               | Publisere, QoS 1, ikke retained                    | Lese                                          |
| `status`                             | Publisere/LWT; ikke autoritativt for sensorkontakt | Har lesetilgang                               |
| `commands`                           | Lese                                               | Publisere, QoS 1, aldri retained, kort TTL    |
| `telemetry-receipt`                  | Lese                                               | Publisere etter varig lagring/avvisningsarkiv |
| `telemetry-undated`                  | Publisere ukjent måletid til diagnostikk           | Lese og arkivere uten oppdiktet UTC           |
| `firmware-request` / `firmware-data` | Be om / motta avgrensede OTA-blokker               | Sende bare under aktiv, autorisert test       |
| `certificate-request`                | Be om fornyelse av egen identitet                  | Formidle til control for signering            |

Sertifikatets verifiserte CN slår opp en eksplisitt ACL for riktig UUID. Selvvalgt client-ID eller stasjons-ID i payload gir ingen ekstra rettigheter. Sertifikatsperring fjerner den aktuelle identitetens tilgang og avslutter aktive brokerforbindelser ved kontrollert restart.

## Telemetri

Felt: `version:1`, `stationId`, `bootId`, monoton `sequence`, `observedAt` som UTC/ISO8601, `firmware`, `sensorContact`, `measurements` og valgfri `configurationHash`. Ved direkte radio sender ESP32 ti normaliserte ISS-byte som `source:{protocol:'davis-iss',packet:'BASE64',channel:0,rssiDbm:-77}`. `channel` er 0–4. Gatewayen verifiserer CRC og konfigurert sender-ID, dekoder og setter individuelle måletider. [Radiokontrakten](davis-radio.md) beskriver felt, utløp og regntelleren. Den alternative serieadapteren sender original 99-byte ramme som `source:{protocol:'davis-loop',packet:'BASE64'}`. Alternative klientmålinger overstyrer ikke rårammen.

Interne enheter: °C, RH-prosent, m/s, hPa og mm. `pressureHpa` er havnivåjustert trykk; `stationPressureHpa` er absolutt trykk. ISS leverer ingen av disse. Lufttrykk står som manglende etter avtale. Ugyldige/manglende verdier er null/utelatt, ikke tallet null. Serveren legger til `receivedAt`, avledede størrelser og metode-/kalibreringsversjon. ISS-observasjoner har også `measurementTimes`, `freshFields`, `iss` og eventuelt `quality`; klienten kan ikke sette disse selv.

Maksimal inntaksmelding er 16 KiB, med rategrense per stasjon. Bare kjente aktive stasjoner godtas. Emneidentitet og payload må stemme. Observasjoner over ett minutt frem i tid eller utenfor retensjon avvises. `(stationId,bootId,sequence)` gir idempotens.

## Kommandoer og kvitteringer

Felles kommandofelt: `version`, `stationId`, `commandId`, positiv `sequence`, `kind`, `issuedAt`, `expiresAt`. Tillatte typer: `restart`, `test_config`, `commit_config`, `rollback_config`, `test_firmware`, `commit_firmware`, `rollback_firmware` og `renew_certificate`. Ingen vilkårlig shell. OTA krever signert bilde og [eget livsløp](firmware-lifecycle.md).

`test_config` har `configuration` og SHA-256 `configurationHash`. RF-innstillingene omfatter brokerens navn/IP, port, kontaktmeldingsintervall, `interface:'davis-iss-rfm69'`, `radioBand:'EU868'`, `transmitterId:1..8`, `spiSck`, `spiMiso`, `spiMosi`, `radioCs`, `radioReset` og `radioDio0`. Seriealternativet har UART-pinner/-baud. Kandidatens JSON og hash kontrolleres lokalt. Commit og rollback er knyttet til hashen; UTC-frist, monoton timer og høyeste kritiske sekvens lagres i NVS.

ACK har `version`, `stationId`, `commandId`, `status`, `configurationHash` og eventuelt `message`. Status er `received`, `testing`, `applied`, `rejected` eller `rolled_back`. Serveren sjekker faktisk kommandorad, identitet, utløp og hash.

## Testforløp

Kandidaten prøves med opprinnelig frist og ordinær TLS-verifikasjon. Gatewayen krever test-ACK og nye, gyldige sensordata med kandidatens hash. «Gjør gjeldende» sender commit og viser ventetilstand til enheten kvitterer. Utløpt frist og kansellering gjenoppretter tidligere serverkonfigurasjon; ESP32 ruller selv tilbake ved lokal frist eller omstart under test.

Tapt siste ACK rundt commit kan gi midlertidig ulik tilstand. Enheten beholder forrige bekreftede konfigurasjon for eksplisitt rollback. Denne grensen må prøves fysisk med pakketap/strømkutt. Ved brokerflytting må gammel inngang beholdes i overgangsvinduet slik at tidligere fungerende konfigurasjon fortsatt er teknisk tilgjengelig.
