# Beregninger og sporbarhet

Alle interne hastigheter er m/s, temperaturer °C, trykk hPa og regn mm. Avrunding skjer ved eksport/presentasjon. Manglende og ugyldige innganger gir `null` internt og tom streng i legacy-filene; de blir aldri nullmålinger. Metodeversjonen er `wg-meteo-2`. Tallfestede eksempler finnes i `test/meteo.test.js` og `test/compatibility.test.js`.

| Størrelse | Implementert metode og begrensning |
| --- | --- |
| Duggpunkt | PsychroLib 2.5.0 / ASHRAE 2017, temperatur og RH. RH=0 gir ingen verdi. |
| Våttemperatur | PsychroLib iterativ ASHRAE-metode med temperatur, RH og **absolutt stasjonstrykk**. Manglende stasjonstrykk erstattes ikke med havnivåtrykk. |
| Vindavkjøling | NWS, temperatur ≤10 °C og vind >1,34 m/s. Vind konverteres til km/h i formelen. |
| Varmeindeks | NWS/Rothfusz med innledende gyldighetskontroll og korreksjon for lav/høy RH. |
| Opplevd temperatur | BOM-formelen uten strålingsledd: T + 0,33e − 0,70v − 4. |
| Humidex | ECCC-metode basert på duggpunkt; vises for temperatur ≥20 °C. |
| Beaufort | Terskeltabell for hastighet i m/s. |
| Retningsmiddel | Hastighetsvektet sirkulær vektormetode som hjelpefunksjon. Ingen retning for vindstille eller kansellerende vektorer. |
| Skybase | Enkel estimatverdi 125 × (T−Td), meter over bakken. Ikke målt skyhøyde. |
| Ekstremer og middel | Inkrementelle min/maks med kildetid, aritmetiske observasjonsmidler per UTC-time og lokalt døgn. Ingen interpolasjon av datagap. |
| Regn | Davis-tellere med stasjonens mm per vipp. Døgnsum bevarer allerede registrert regn ved tellerreset og kalibreringsendring. Senere tellerøkning bruker gjeldende kalibrering. |
| Trend | Sunnmørsværs terskler; trykk bruker tre timers lineær regresjon med minst seks punkter og 2,75 timers dekning. |
| Astronomi | Astronomy Engine 2.1.19: sol-/måneoppgang og -nedgang, borgerlig skumring, månefase og belyst andel. Manglende opp-/nedgang ved polarforhold gir null. Terrenghorisont inngår ikke. |

Davis LOOP2-felt 7 er konsollens havnivåjusterte trykk. Felt 67 er absolutt trykk. Gatewayen utfører ikke ny havnivåkorreksjon på felt 7. LOOP/LOOP2 CRC er CRC-CCITT/XMODEM med polynom 0x1021 og startverdi 0. Rain collector-verdien må passe fysisk måler; 0,2 mm/vipp er en synlig standard som må kontrolleres på hver stasjon.

Prosjektets valgte datavei er direkte ISS-radio via RFM69HCW på 868 MHz. Den har egen CRC-kontroll og dekoder `wg-iss-1`, med individuelle måletider og utløp. [Radiodokumentet](davis-radio.md) beskriver kildegrunnlag, modellspesifikk vindretning og regnakkumulering. Lufttrykk er etter avtale manglende; trykkavhengige beregninger blir derfor også manglende. Ingen havnivå- eller stasjonstrykk estimeres fra stasjonshøyden alene.

ET, solmaksimum/solskinnstimer, graddager, vindrun/vindrose og komplett WD-rekord-/alarmfunksjon er ennå ikke implementert. De regnes ikke som null eller erstattes med antatte målinger. Se leveransestatus.

## Primærkilder

- [PsychroLib, ASHRAE-metoder og tester](https://github.com/psychrometrics/psychrolib). JavaScript-kilden er vendoret uendret under MIT. Revisjon: `a42717d24ed08534642d6caf7dcbbf72b9510bea`; SHA-256: `a46572b93a90263b8e19e8d1372fe3135429aa9611cd57e00674188640cc96c9`. Lisens og kildehenvisning ligger ved koden.
- [NWS vindavkjøling](https://www.weather.gov/safety/cold-wind-chill-chart) og [NWS varmeindeksligning](https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml).
- [FMI: implementasjon av BOM apparent temperature](https://github.com/fmidev/smartmet-library-newbase/blob/master/newbase/NFmiMetMath.cpp), [ECCC: humidex](https://climate.weather.gc.ca/glossary_e.html).
- [Astronomy Engine: JavaScript API](https://github.com/cosinekitty/astronomy/tree/master/source/js).
- [Davis: offisiell protokollmanual 2.6.1 via leverandørens nedlastinger](https://www.davisinstruments.com/pages/software-firmware-updates).

Disse kildene begrunner metodene. De dokumenterer ikke at Weather Display bruker identiske metoder i alle felt. Full ekvivalens trenger referansekjøringer mot den valgte WD-versjonen.
