import { z } from 'zod';

export const id = z.string().uuid();
export const role = z.enum(['viewer', 'operator', 'administrator']);
const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/)
  .refine((v) => !v.includes('..'));
const origin = (httpsOnly = false) =>
  z
    .string()
    .url()
    .refine((value) => {
      const u = new URL(value);
      return (
        (u.protocol === 'https:' ||
          (!httpsOnly && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) &&
        !u.username &&
        !u.password &&
        u.pathname === '/' &&
        !u.search &&
        !u.hash
      );
    }, 'Adressen må være en HTTPS-opprinnelse uten sti eller legitimasjon');
export const directorySchema = z
  .object({
    urls: z
      .array(
        z
          .string()
          .url()
          .refine((v) => {
            const u = new URL(v);
            return u.protocol === 'ldaps:' && !u.username && !u.password && ['', '/'].includes(u.pathname);
          }, 'Kun LDAPS uten legitimasjon i URL er tillatt'),
      )
      .max(4),
    baseDn: z.string().max(500),
    bindDn: z.string().max(500),
    groups: z
      .array(
        z
          .object({
            dn: z.string().min(1).max(500),
            sid: z
              .string()
              .regex(/^S-\d(-\d+)+$/)
              .optional(),
            role,
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export const gatewaySchema = z
  .object({
    confirmationSeconds: z.number().int().min(30).max(3600).default(300),
    adminOrigin: origin(),
    publicOrigin: origin(true),
    developmentOrigin: origin().optional(),
    productionOrigin: origin(true).optional(),
    sessionIdleMinutes: z.number().int().min(5).max(120).default(30),
    sessionAbsoluteHours: z.number().int().min(1).max(24).default(8),
    retentionDays: z.number().int().min(7).max(3650).default(365),
    warningSeconds: z.number().int().min(10).max(86400).default(180),
    downSeconds: z.number().int().min(20).max(172800).default(300),
    directory: directorySchema,
  })
  .strict()
  .refine((v) => v.downSeconds > v.warningSeconds, 'Nedetidsgrense må være større enn varslingsgrense');
export const stationSchema = z
  .object({
    id,
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/),
    name: z.string().trim().min(1).max(100),
    model: z.enum(['Davis Vantage Vue', 'Davis Vantage Pro2', 'Netatmo']),
    enabled: z.boolean(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    elevationM: z.number().min(-500).max(9000),
    exportName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,60}\.txt$/),
    rainCounterMmPerUnit: z.number().positive().max(10).default(0.2),
  })
  .strict();
const gpio = z
  .number()
  .int()
  .refine((v) => [13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33].includes(v));
const deviceBase = {
  stationId: id,
  mqttHost: host,
  mqttPort: z.number().int().min(1).max(65535),
  sampleSeconds: z.number().int().min(1).max(300),
};
export const radioDeviceSchema = z
  .object({
    ...deviceBase,
    interface: z.literal('davis-iss-rfm69'),
    radioBand: z.literal('EU868'),
    transmitterId: z.number().int().min(1).max(8),
    spiSck: gpio,
    spiMiso: gpio,
    spiMosi: gpio,
    radioCs: gpio,
    radioReset: gpio,
    radioDio0: gpio,
  })
  .strict()
  .refine(
    (v) => new Set([v.spiSck, v.spiMiso, v.spiMosi, v.radioCs, v.radioReset, v.radioDio0]).size === 6,
    'Radiopinnene må være forskjellige',
  );
const serialDeviceSchema = z
  .object({
    stationId: id,
    mqttHost: host,
    mqttPort: z.number().int().min(1).max(65535),
    sampleSeconds: z.number().int().min(1).max(300),
    uartRx: z
      .number()
      .int()
      .refine((v) => [16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33].includes(v)),
    uartTx: z
      .number()
      .int()
      .refine((v) => [16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33].includes(v)),
    uartBaud: z.enum(['19200', '9600', '2400', '1200']),
  })
  .strict()
  .refine((v) => v.uartRx !== v.uartTx, 'RX og TX må være forskjellige');
export const deviceSchema = z.union([radioDeviceSchema, serialDeviceSchema]);
export function defaultDevice(stationId, publicOrigin, environment) {
  return radioDeviceSchema.parse({
    stationId,
    mqttHost: new URL(publicOrigin).hostname,
    mqttPort: environment === 'development' ? 8884 : 8883,
    sampleSeconds: 2,
    interface: 'davis-iss-rfm69',
    radioBand: 'EU868',
    transmitterId: 1,
    spiSck: 18,
    spiMiso: 19,
    spiMosi: 23,
    radioCs: 27,
    radioReset: 14,
    radioDio0: 26,
  });
}
const optionalNumber = (min, max) => z.number().finite().min(min).max(max).nullable().optional();
export const telemetrySchema = z
  .object({
    version: z.literal(1),
    stationId: id,
    bootId: id,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    observedAt: z.string().datetime({ offset: true }),
    firmware: z.string().max(80),
    sensorContact: z.boolean(),
    measurements: z
      .object({
        temperatureC: optionalNumber(-90, 65),
        indoorTemperatureC: optionalNumber(-40, 85),
        humidityPct: optionalNumber(0, 100),
        indoorHumidityPct: optionalNumber(0, 100),
        pressureHpa: optionalNumber(800, 1150),
        stationPressureHpa: optionalNumber(200, 1150),
        windSpeedMs: optionalNumber(0, 120),
        windMeanMs: optionalNumber(0, 120),
        windGustMs: optionalNumber(0, 150),
        windDirectionDeg: optionalNumber(0, 360),
        rainCounterMm: optionalNumber(0, 100000),
        rainTodayMm: optionalNumber(0, 5000),
        rainRateMmH: optionalNumber(0, 5000),
        solarWm2: optionalNumber(0, 2000),
        uvIndex: optionalNumber(0, 30),
        rainLastHourMm: optionalNumber(0, 5000),
        rainLast24HoursMm: optionalNumber(0, 10000),
        rainLast15MinutesMm: optionalNumber(0, 5000),
      })
      .strict(),
    configurationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    source: z
      .discriminatedUnion('protocol', [
        z
          .object({
            protocol: z.literal('davis-loop'),
            packet: z
              .string()
              .length(132)
              .regex(/^[A-Za-z0-9+/]+={0,2}$/),
          })
          .strict(),
        z
          .object({
            protocol: z.literal('davis-iss'),
            packet: z
              .string()
              .length(16)
              .regex(/^[A-Za-z0-9+/]{14}==$/),
            channel: z.number().int().min(0).max(4),
            rssiDbm: z.number().min(-140).max(0),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export const ackSchema = z
  .object({
    version: z.literal(1),
    stationId: id,
    commandId: id,
    status: z.enum(['received', 'testing', 'applied', 'rejected', 'rolled_back']),
    configurationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    message: z.string().max(200).optional(),
  })
  .strict();

export function validateScope(scope, payload) {
  if (scope === 'gateway') return gatewaySchema.parse(payload);
  const invalid = (message) => {
    throw new z.ZodError([{ code: 'custom', path: ['scope'], message }]);
  };
  if (scope.startsWith('station:')) {
    const v = stationSchema.parse(payload);
    if (v.id !== scope.slice(8)) invalid('Stasjonsidentitet kan ikke endres');
    return v;
  }
  if (scope.startsWith('device:')) {
    const v = deviceSchema.parse(payload);
    if (v.stationId !== scope.slice(7)) invalid('Enhetsidentitet kan ikke endres');
    return v;
  }
  invalid('Ukjent konfigurasjonsområde');
}
