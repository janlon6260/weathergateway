import mqtt from 'mqtt';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { configuration } from '../server/bootstrap.js';

const config = configuration();
if (config.environment !== 'development') throw new Error('Simulatoren får bare kjøre i utvikling');
if (!process.env.WG_STATION_ID || !config.mqttUrl?.startsWith('mqtts:'))
  throw new Error('WG_STATION_ID og MQTT/TLS-konfigurasjon kreves');
const stationId = process.env.WG_STATION_ID,
  bootId = randomUUID();
const client = mqtt.connect(config.mqttUrl, {
  protocolVersion: 5,
  clientId: `sim-${stationId}`,
  ca: readFileSync(config.mqttCaFile),
  cert: readFileSync(config.mqttCertFile),
  key: readFileSync(config.mqttKeyFile),
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2',
});
let sequence = 0;
const timer = setInterval(() => {
  if (!client.connected) return;
  const phase = Date.now() / 60000;
  client.publish(
    `wg/v1/development/stations/${stationId}/telemetry`,
    JSON.stringify({
      version: 1,
      stationId,
      bootId,
      sequence: sequence++,
      observedAt: new Date().toISOString(),
      firmware: 'simulator-1',
      sensorContact: true,
      measurements: {
        temperatureC: 10 + Math.sin(phase),
        humidityPct: 75,
        pressureHpa: 1013.25,
        windSpeedMs: 3 + Math.sin(phase),
        windMeanMs: 3,
        windGustMs: 5,
        windDirectionDeg: 240,
        rainTodayMm: 2.4,
        rainRateMmH: 0,
      },
    }),
    { qos: 1, retain: false },
  );
}, 2000);
process.on('SIGINT', () => {
  clearInterval(timer);
  client.end();
});
