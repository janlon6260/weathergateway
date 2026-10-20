import { isIP } from 'node:net';
export function mqttSubjectAltNames(primary, additional = '') {
  const values = [
    ...new Set([
      primary,
      'broker',
      ...additional
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ]),
  ];
  if (values.length > 20) throw new Error('For mange MQTT-identiteter');
  return values
    .map((value) => {
      const ip = value.replace(/^\[|\]$/g, '');
      if (isIP(ip)) return `IP:${ip}`;
      if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(value) || value.includes('..'))
        throw new Error('Ugyldig MQTT-identitet');
      return `DNS:${value}`;
    })
    .join(',');
}
