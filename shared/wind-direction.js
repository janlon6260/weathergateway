export const windDirectionDefaults = {
  decoder: 'model',
  zero: 'north',
  reverse: false,
  rawStart: 0,
  rawEnd: 255,
  degreesStart: 0,
  degreesEnd: 360,
};
export const windDirectionProfiles = {
  model: 'Automatisk fra stasjonsmodell',
  'davis-pro2': 'Vantage Pro2 – DavisRFM69',
  'davis-pro2-adjusted': 'Vantage Pro2 – Meteostick',
  'davis-vue': 'Vantage Vue – DavisRFM69',
  'linear-256': 'Lineær: 256 trinn per omdreining',
  custom: 'Egendefinert topunktskalering',
};
export const normalizeDirection = (degrees) => ((degrees % 360) + 360) % 360;
export function decodeWindDirection(raw, model, settings = {}) {
  if (!Number.isInteger(raw) || raw < 0 || raw > 255) return null;
  const options = { ...windDirectionDefaults, ...settings };
  if (raw === 0 && options.zero === 'missing') return null;
  let degrees;
  const profile =
    options.decoder === 'model'
      ? model === 'Davis Vantage Vue'
        ? 'davis-vue'
        : 'davis-pro2'
      : options.decoder;
  if (raw === 0 && options.zero === 'north') degrees = 0;
  else if (profile === 'davis-pro2') degrees = 9 + (raw * 342) / 255;
  else if (profile === 'davis-pro2-adjusted')
    degrees = raw === 0 ? 5 : raw === 255 ? 355 : 9 + ((raw - 1) * 342) / 253;
  else if (profile === 'davis-vue') degrees = (raw * 360) / 256 + 0.3;
  else if (profile === 'linear-256') degrees = (raw * 360) / 256;
  else if (profile === 'custom' && options.rawStart !== options.rawEnd)
    degrees =
      options.degreesStart +
      ((raw - options.rawStart) * (options.degreesEnd - options.degreesStart)) /
        (options.rawEnd - options.rawStart);
  else return null;
  return Number.isFinite(degrees) ? normalizeDirection(options.reverse ? -degrees : degrees) : null;
}
