import { z } from 'zod';
import { meteorologyDefaults, calibrationDefaults } from '../shared/meteorology-settings.js';
import { alarmMetrics } from '../shared/alarm-metrics.js';
export { meteorologyDefaults };
import { databaseColumns, optionalDatabaseMetrics } from '../shared/database-columns.js';
export { databaseColumns };

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
    backupIntervalHours: z.number().int().min(0).max(168).default(24),
    backupKeepCount: z.number().int().min(2).max(365).default(30),
    dataWarningSeconds: z.number().min(0.1).max(86400).default(3),
    dataDownSeconds: z.number().min(1).max(172800).default(30),
    databaseLoggingEnabled: z.boolean().default(true),
    warningSeconds: z.number().int().min(10).max(86400).default(180),
    downSeconds: z.number().int().min(20).max(172800).default(300),
    directory: directorySchema,
  })
  .strict()
  .refine(
    (v) => v.downSeconds > v.warningSeconds && v.dataDownSeconds > v.dataWarningSeconds,
    'Nedetidsgrense må være større enn varslingsgrense',
  );
export const meteorologySchema = z
  .object({
    windWindowSeconds: z.number().int().min(60).max(3600),
    maximumGapSeconds: z.number().int().min(3).max(300),
    minimumCoverage: z.number().min(0.5).max(1),
    windHeightM: z.number().min(0.5).max(100),
    heatingBaseC: z.number().min(-20).max(40),
    growingBaseC: z.number().min(-20).max(40),
    growingCeilingC: z.number().min(-10).max(60),
    sunshineThresholdWm2: z.number().min(1).max(1500),
    rainDayStartHour: z.number().int().min(0).max(23),
    wetDayThresholdMm: z.number().positive().max(100),
  })
  .strict()
  .refine((v) => v.growingCeilingC > v.growingBaseC, 'Øvre grense må være større enn vekstgrunnlaget');
export const stationSchema = z
  .object({
    id,
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/),
    name: z.string().trim().min(1).max(100),
    model: z.enum(['Davis Vantage Vue', 'Davis Vantage Pro2', 'Netatmo']),
    enabled: z.boolean(),
    freshness: z
      .object({ warningSeconds: z.number().min(0.1).max(86400), downSeconds: z.number().min(1).max(172800) })
      .strict()
      .refine((v) => v.downSeconds > v.warningSeconds)
      .nullable()
      .default(null),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    elevationM: z.number().min(-500).max(9000),
    exportName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,60}\.txt$/),
    rainCounterMmPerUnit: z.number().positive().max(10).default(0.2),
    meteorology: meteorologySchema.default(meteorologyDefaults),
    calibration: z
      .object({
        temperatureOffsetC: z.number().min(-20).max(20),
        humidityOffsetPct: z.number().min(-50).max(50),
        pressureOffsetHpa: z.number().min(-100).max(100),
        windFactor: z.number().positive().max(10),
        windDirectionOffsetDeg: z.number().min(-360).max(360),
        solarFactor: z.number().positive().max(10),
      })
      .strict()
      .default(calibrationDefaults),
    qualityRules: z
      .array(
        z
          .object({
            metric: z.enum([
              'temperatureC',
              'humidityPct',
              'pressureHpa',
              'windSpeedMs',
              'solarWm2',
              'uvIndex',
            ]),
            maximumChangePerMinute: z.number().positive().max(100000).nullable(),
            stuckSeconds: z.number().int().min(0).max(604800),
            action: z.enum(['flag', 'missing']),
          })
          .strict(),
      )
      .max(6)
      .refine(
        (rules) => new Set(rules.map((r) => r.metric)).size === rules.length,
        'Bare én kvalitetsregel per måling er tillatt',
      )
      .default([]),
    templates: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,60}\.(?:txt|csv|html)$/),
            content: z.string().min(1).max(32000),
          })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict();
const columnName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export const databaseSchema = z
  .object({
    stationId: id,
    enabled: z.boolean().default(false),
    loggingEnabled: z.boolean().default(true),
    host: z.union([host, z.literal('')]).default(''),
    port: z.number().int().min(1).max(65535).default(3306),
    transport: z.preprocess(
      (value) => (value === 'vpn' ? 'lan' : value),
      z.enum(['lan', 'tls']).default('lan'),
    ),
    database: z
      .string()
      .max(64)
      .regex(/^[A-Za-z0-9_-]*$/)
      .default(''),
    user: z.string().max(128).default(''),
    passwordEnv: z
      .string()
      .regex(/^WG_DB_PASSWORD(?:_[A-Z0-9_]{1,48})?$/)
      .default('WG_DB_PASSWORD'),
    passwordSecret: z
      .string()
      .regex(/^weather-db:[0-9a-f-]{36}$/)
      .nullable()
      .default(null),
    stationKey: z.string().min(1).max(100),
    stationNameColumn: columnName.nullable().default(null),
    intervalSeconds: z.number().int().min(1).max(86400).default(60),
    windUnit: z.enum(['kmh', 'ms']).default('kmh'),
    columns: z
      .object(
        Object.fromEntries([
          ...Object.entries(databaseColumns).map(([key, value]) => [
            key,
            columnName.nullable().default(value),
          ]),
          ...Object.keys(optionalDatabaseMetrics).map((key) => [key, columnName.nullable().default(null)]),
        ]),
      )
      .strict()
      .default({
        ...databaseColumns,
        ...Object.fromEntries(Object.keys(optionalDatabaseMetrics).map((key) => [key, null])),
      }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const names = Object.values(value.columns)
      .filter(Boolean)
      .map((name) => name.toLowerCase());
    const allNames = [...names, ...(value.stationNameColumn ? [value.stationNameColumn.toLowerCase()] : [])];
    if (
      new Set(allNames).size !== allNames.length ||
      allNames.some((name) => ['id', 'station_id', 'date', 'time'].includes(name))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['columns'],
        message: 'Kolonner må være unike og kan ikke erstatte identitet eller tid',
      });
    if (value.enabled && (!value.host || !value.database || !value.user || !names.length))
      ctx.addIssue({
        code: 'custom',
        message: 'Aktiv databaseskriving krever vert, database, bruker og målekolonner',
      });
  });
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
export const rs485CaptureDeviceSchema = z
  .object({
    ...deviceBase,
    interface: z.literal('davis-iss-rs485-capture'),
    uartRx: gpio,
    rs485De: gpio,
    rs485Re: gpio,
    uartBaud: z.enum(['1200', '2400', '4800', '9600', '19200', '38400']),
  })
  .strict()
  .refine((v) => new Set([v.uartRx, v.rs485De, v.rs485Re]).size === 3, 'RS-485-pinnene må være forskjellige');
export const deviceSchema = z.union([radioDeviceSchema, serialDeviceSchema, rs485CaptureDeviceSchema]);
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
    firmwareReleaseId: id.optional(),
    timeQuality: z.enum(['ntp', 'mappedWithinBoot']).optional(),
    certificateId: id.optional(),
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
        soilTemperatureC: optionalNumber(-40, 85),
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
    certificateId: id.optional(),
    firmwareReleaseId: id.optional(),
  })
  .strict();

export const firmwareManifestSchema = z
  .object({
    format: z.literal('wg-firmware-1'),
    stationId: id,
    environment: z.enum(['production', 'development', 'test']),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/)
      .max(64),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    size: z.number().int().min(1024).max(0x180000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const firmwareUpdateSchema = z.object({ stationId: id, releaseId: id.nullable() }).strict();
export const alarmRuleSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    metric: z.enum(Object.keys(alarmMetrics)),
    comparison: z.enum(['above', 'below', 'missing']),
    threshold: z.number().finite().min(-100000).max(100000),
    hysteresis: z.number().min(0).max(10000),
    delaySeconds: z.number().int().min(0).max(86400),
    clearDelaySeconds: z.number().int().min(0).max(86400),
  })
  .strict();
export const alarmsSchema = z
  .object({ stationId: id, rules: z.array(alarmRuleSchema).max(50) })
  .strict()
  .refine((v) => new Set(v.rules.map((r) => r.id)).size === v.rules.length, 'Alarm-ID må være unik');
const email = z.string().email().max(254);
export const notificationRuleSchema = z
  .object({
    id,
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((v) => !/[\r\n]/.test(v)),
    enabled: z.boolean().default(true),
    kind: z.enum([
      'station_offline',
      'esp_offline',
      'data_age',
      'sensor_contact_lost',
      'heap_low',
      'spool_dropped',
    ]),
    stationIds: z.array(id).max(100).default([]),
    thresholdSeconds: z.number().int().min(0).max(604800).default(30),
    minimumHeapBytes: z.number().int().min(1024).max(1000000).default(32768),
    repeatSeconds: z.number().int().min(0).max(604800).default(900),
    sendRecovery: z.boolean().default(true),
    recipients: z.array(email).max(50).default([]),
  })
  .strict();
export const notificationsSchema = z
  .object({
    enabled: z.boolean().default(false),
    recipients: z.array(email).max(50).default([]),
    smtp: z
      .object({
        host: z.union([host, z.literal('')]).default(''),
        port: z.number().int().min(1).max(65535).default(587),
        security: z.enum(['none', 'starttls', 'tls']).default('starttls'),
        authEnabled: z.boolean().default(false),
        user: z.string().max(254).default(''),
        passwordSecret: z
          .string()
          .regex(/^smtp:[0-9a-f-]{36}$/)
          .nullable()
          .default(null),
        from: z.union([email, z.literal('')]).default(''),
        caCertificate: z.string().max(32000).default(''),
      })
      .strict()
      .default({
        host: '',
        port: 587,
        security: 'starttls',
        authEnabled: false,
        user: '',
        passwordSecret: null,
        from: '',
        caCertificate: '',
      }),
    rules: z.array(notificationRuleSchema).max(100).default([]),
  })
  .strict()
  .refine(
    (v) => !v.enabled || (!!v.smtp.host && !!v.smtp.from && (!v.smtp.authEnabled || !!v.smtp.user)),
    'Fyll inn SMTP-vert, avsender og eventuelt brukernavn',
  )
  .refine((v) => new Set(v.rules.map((r) => r.id)).size === v.rules.length, 'Varsel-ID må være unik');

export function validateScope(scope, payload) {
  if (scope === 'gateway') return gatewaySchema.parse(payload);
  if (scope === 'notifications') return notificationsSchema.parse(payload);
  const invalid = (message) => {
    throw new z.ZodError([{ code: 'custom', path: ['scope'], message }]);
  };
  if (scope.startsWith('station:')) {
    const v = stationSchema.parse(payload);
    if (v.id !== scope.slice(8)) invalid('Stasjonsidentitet kan ikke endres');
    if (new Set([v.exportName, ...v.templates.map((t) => t.name)]).size !== v.templates.length + 1)
      invalid('Filnavn må være unike for stasjonen');
    return v;
  }
  if (scope.startsWith('device:')) {
    const v = deviceSchema.parse(payload);
    if (v.stationId !== scope.slice(7)) invalid('Enhetsidentitet kan ikke endres');
    return v;
  }
  if (scope.startsWith('database:')) {
    const v = databaseSchema.parse(payload);
    if (v.stationId !== scope.slice(9)) invalid('Databasekoblingens stasjon kan ikke endres');
    return v;
  }
  if (scope.startsWith('firmware:')) {
    const v = firmwareUpdateSchema.parse(payload);
    if (v.stationId !== scope.slice(9)) invalid('Firmware gjelder en annen stasjon');
    return v;
  }
  if (scope.startsWith('alarms:')) {
    const v = alarmsSchema.parse(payload);
    if (v.stationId !== scope.slice(7)) invalid('Alarmene gjelder en annen stasjon');
    return v;
  }
  invalid('Ukjent konfigurasjonsområde');
}
