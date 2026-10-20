// Units: Celsius, kPa, m/s, MJ/m²/day, mm/day. Methods and references:
// docs/calculations.md. Missing inputs remain missing; pressure is never guessed.
export const climateVersion = 'wg-climate-1';
const finite = (...values) => values.every((v) => typeof v === 'number' && Number.isFinite(v));
const radians = (degrees) => (degrees * Math.PI) / 180;
export const saturationVapourPressure = (temperatureC) =>
  finite(temperatureC) && temperatureC >= -90 && temperatureC <= 65
    ? 0.6108 * Math.exp((17.27 * temperatureC) / (temperatureC + 237.3))
    : null;

export function degreeDays(minC, maxC, baseC = 18.3333333333) {
  if (!finite(minC, maxC, baseC) || minC > maxC) return null;
  const meanC = (minC + maxC) / 2;
  return { heating: Math.max(0, baseC - meanC), cooling: Math.max(0, meanC - baseC), baseC };
}

export function growingDegreeDays(minC, maxC, baseC = 10, ceilingC = 30) {
  if (!finite(minC, maxC, baseC, ceilingC) || minC > maxC || ceilingC <= baseC) return null;
  return Math.max(
    0,
    (Math.min(ceilingC, Math.max(baseC, minC)) + Math.min(ceilingC, Math.max(baseC, maxC))) / 2 - baseC,
  );
}

export function extraterrestrialRadiation(latitude, dayOfYear) {
  if (!finite(latitude, dayOfYear) || Math.abs(latitude) > 90 || dayOfYear < 1 || dayOfYear > 366)
    return null;
  const phi = radians(latitude),
    angle = (2 * Math.PI * dayOfYear) / 365;
  const dr = 1 + 0.033 * Math.cos(angle),
    declination = 0.409 * Math.sin(angle - 1.39);
  const sunset = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(declination))));
  return Math.max(
    0,
    ((24 * 60) / Math.PI) *
      0.082 *
      dr *
      (sunset * Math.sin(phi) * Math.sin(declination) +
        Math.cos(phi) * Math.cos(declination) * Math.sin(sunset)),
  );
}

export function clearSkyRadiation(solarAltitudeDegrees) {
  if (!finite(solarAltitudeDegrees) || solarAltitudeDegrees < -90 || solarAltitudeDegrees > 90) return null;
  const cosine = Math.sin(radians(solarAltitudeDegrees));
  return cosine <= 0 ? 0 : 1098 * cosine * Math.exp(-0.059 / cosine);
}

// FAO-56, equations 6, 8, 11-13, 25, 35-39, 47; daily reference grass ET.
export function referenceEt(input) {
  const {
    minC,
    maxC,
    actualVapourKpa,
    windMs,
    windHeightM,
    solarMj,
    stationPressureHpa,
    latitude,
    elevationM,
    dayOfYear,
  } = input;
  if (
    !finite(
      minC,
      maxC,
      actualVapourKpa,
      windMs,
      windHeightM,
      solarMj,
      stationPressureHpa,
      latitude,
      elevationM,
      dayOfYear,
    ) ||
    minC > maxC ||
    minC < -90 ||
    maxC > 65 ||
    windMs < 0 ||
    windHeightM < 0.5 ||
    windHeightM > 100 ||
    solarMj < 0 ||
    stationPressureHpa < 200 ||
    stationPressureHpa > 1150 ||
    actualVapourKpa < 0
  )
    return null;
  const meanC = (minC + maxC) / 2,
    es = (saturationVapourPressure(minC) + saturationVapourPressure(maxC)) / 2;
  if (!Number.isFinite(es) || actualVapourKpa > es + 0.05) return null;
  const ra = extraterrestrialRadiation(latitude, dayOfYear),
    rso = (0.75 + 0.00002 * elevationM) * ra;
  // The daily FAO cloudiness correction is undefined in polar night.
  if (!(rso > 0)) return null;
  const u2 = (windMs * 4.87) / Math.log(67.8 * windHeightM - 5.42);
  const gamma = 0.000665 * (stationPressureHpa / 10);
  const slope = (4098 * saturationVapourPressure(meanC)) / (meanC + 237.3) ** 2;
  const rnl =
    4.903e-9 *
    (((maxC + 273.16) ** 4 + (minC + 273.16) ** 4) / 2) *
    (0.34 - 0.14 * Math.sqrt(actualVapourKpa)) *
    (1.35 * Math.max(0.3, Math.min(1, solarMj / rso)) - 0.35);
  const rn = 0.77 * solarMj - rnl;
  return Math.max(
    0,
    (0.408 * slope * rn + gamma * (900 / (meanC + 273)) * u2 * Math.max(0, es - actualVapourKpa)) /
      (slope + gamma * (1 + 0.34 * u2)),
  );
}
