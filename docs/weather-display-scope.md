# Weather Display: funksjonsmatrise

Referanse sjekket 19. oktober 2026: leverandørens nettsted oppgir **10.37S Build 153**. Endringshistorikken har en oppdatering 18. oktober 2026. Funksjonsreferansen fryses til denne versjonen ved oppstart, slik at «siste versjon» ikke gir et udefinert, bevegelig ferdigkriterium. [Weather Display](https://www.weather-display.com/index.php), [leverandørens endringshistorikk](https://www.weather-display.com/history.php).

Leverandøren beskriver blant annet historikk/grafer, ekstremer, klima-/nedbørsrapporter, egendefinerte maler, ekstra sensorer, alarmer og en rekke integrasjoner. Dette er en start på inventaret, ikke en full teknisk spesifikasjon av alle algoritmer og filformater. [Offisiell funksjonsoversikt](https://www.weather-display.com/features.php).

## Funksjonsomfang

| Funksjonsfamilie                                | Mål                                                                             | Verifikasjon før den regnes som ferdig                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Råmålinger og ekstra sensorer                   | Registrere alle tilgjengelige Davis-verdier, enheter, sensorkontakt og kildetid | Dokumentert Davis-pakkeformat, ugyldighetsverdier og reelle pakkefiksturer      |
| Sanntid og historikk                            | Flere stasjoner, filtrering, grafer og sporbare målinger                        | Sortering, duplikater, sen ankomst, datatap og belastning                       |
| Kalibrering og datakvalitet                     | Bevar råverdi; kalibrering er versjonert; feilverdier kan forklares             | Sensorgrenser, sprang, fastlåste sensorer og endring av kalibrering             |
| Temperatur og fuktindekser                      | Duggpunkt, vindavkjøling, varmeindeks, tilsynelatende temperatur og humidex     | Uavhengige referanseverdier, enheter og gyldighetsområder                       |
| Trykk                                           | Sensortrykk, stasjonstrykk, havnivåtrykk og trend som separate størrelser       | Høyde-/temperaturgrunnlag, sensorens egen korreksjon og ingen dobbeltkorreksjon |
| Vindstatistikk                                  | Øyeblikksvind, middelvind, kast, retning, vindrose, vindrun og Beaufort         | Definerte vinduer, vektet/sirkulær retning, tidsdekning og vindstille           |
| Nedbør                                          | Intensitet, time-/døgn-/måned-/årssum, regnhendelser og tørre/våte perioder     | Telleverksreset/-overløp, strømbrudd, sen ankomst og justerbar døgnstart        |
| Ekstremer og rekorder                           | Min/maks med tid og kilde per valgt periode                                     | Reberegning etter korrigerte/sene data, tidszoner og manglende dekning          |
| Klima og rapporter                              | Døgn-, måned-, års- og NOAA-lignende klimautdata etter avklart format           | Sammenligning av hele rapporter og dokumentert behandling av manglende data     |
| Sol, UV og astronomi                            | Tilgjengelige sensorverdier og referansebaserte avledninger                     | Sensor-/posisjonsgrunnlag og spesifiserte algoritmer                            |
| Skybase, våttemperatur, ET og graddager         | Egen beregningskatalog; bare beregn når nødvendige innganger finnes             | Publisert metode, forutsetninger, referanser og toleranser per parameter        |
| Alarmer                                         | Terskler, forsinkelse, hysterese og historikk i administrasjonen                | Gjentatte/manglende målinger, tilbakegang og audit                              |
| Filer og maler                                  | Eksisterende Sunnmørsvær-filer først; øvrige WD-utdata inventariseres           | Filnavn, feltnavn, datatyper, avrunding, tegnsett og atomisk utskifting         |
| Import og eksport                               | Sporbar innlesing av eksisterende historikk og tillatte rapportutdata           | Duplikater, tidszoner og enheter; aldri blind overskriving                      |
| Kamera, video, tale og øvrige lokale WD-verktøy | Avklares i totalinventaret; ikke stille utelatt fra «alt»                       | Eksplisitt beslutning om hver funksjonsfamilie                                  |
| Tredjepartsintegrasjoner                        | Utgående tjenester som Weather Underground er unntatt av bruker                 | Ingen slike tjenester aktiveres som en skjult standard                          |
| Netatmo                                         | Egen, senere datakilde                                                          | Utsatt etter brukerens avklaring                                                |

Node-implementasjonen leverer nå målingsinntak, direkte ISS/EU868, værindekser, tidsvektet vind/retning, vindrun/vindrose, regnvinduer/hendelser/våte og tørre perioder, graddager, FAO-56 referanse-ET, astronomi, kalibrering/kvalitetsregler, rekorder, alarmregler, grafer, rapporter, trygge maler og historikkimport. Se [metoder og datakrav](calculations.md). Referanse-ET er implementert, men blir manglende uten blant annet absolutt stasjonstrykk.

De eksisterende Sunnmørsvær-filene og Socket.IO-hendelsene har egne kompatibilitetsadaptere. Egne eksportmaler er ikke en full tolk for alle WD-tagger, og klimateksten er et dokumentert Weather Gateway-format, ikke påstått identisk NOAA/WD-layout. Ekstra radio-/sensormoduler, kamera/video, tale og reléstyring er ikke implementert uten en valgt kilde og konkret kontrakt. Disse punktene og fysisk verifikasjon står fortsatt i [leveransestatus](release-status.md); hele WD-paritet skal ikke erklæres på grunnlag av lokale formeltester.

## Beregningskatalog

Hver beregning skal registrere metode-/versjonsnavn, inngangsstørrelser og enheter, gyldighetsområde, manglende verdi med årsak, presisjon og referansefiksturer. Avrunding skjer ved presentasjon/eksport. Råmålinger og avledede verdier bevares hver for seg; en senere metodeendring skal kunne spores.

NWS gir dokumenterte vindavkjølings- og varmeindeksmetoder. Disse brukes som mulige, eksplisitte referanser med sine gyldighetsområder, ikke som grunnlag for å anta Weather Displays eksakte interne metode. [NWS: vindavkjøling](https://www.weather.gov/safety/cold-wind-chill-chart), [NWS: varmeindeks](https://www.weather.gov/ict/wbgt).

Målemetode, plassering, tidsmidling og kvalitet må vurderes sammen med formelen. WMO-No. 8 er et relevant referansegrunnlag for observasjon og kvalitetsarbeid; å sitere den er ikke i seg selv en sertifisering av en privat værstasjon. [WMO: Guide to Instruments and Methods of Observation](https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/instruments-and-methods-of-observation-programme-imop/guide-instruments-and-methods-of-observation-wmo-no-8).

Likhet med Weather Display må testes mot kontrollerte innganger og forventede resultater, med eksplisitt toleranse der metodene avviker. En verdi som ligner i noen få live-observasjoner er utilstrekkelig bevis på korrekt implementasjon.
