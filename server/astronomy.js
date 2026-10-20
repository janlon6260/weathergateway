import {
  Body,
  Observer,
  SearchRiseSet,
  SearchAltitude,
  Illumination,
  MoonPhase,
  Equator,
  Horizon,
} from 'astronomy-engine';
import { clearSkyRadiation } from './climate.js';
import { DateTime } from 'luxon';

const cache = new Map();
export function currentSolarMaximum(station, at) {
  const observer = new Observer(station.latitude, station.longitude, station.elevationM);
  const date = new Date(at),
    equator = Equator(Body.Sun, date, observer, true, true);
  return clearSkyRadiation(Horizon(date, observer, equator.ra, equator.dec, 'normal').altitude);
}
export function astronomy(station, date) {
  const start = DateTime.fromISO(date, { zone: 'Europe/Oslo' }).startOf('day'),
    end = start.plus({ days: 1 });
  if (!start.isValid) throw new Error('Ugyldig astronomidato');
  const key = JSON.stringify([date, station.latitude, station.longitude, station.elevationM]);
  if (cache.has(key)) return cache.get(key);
  const observer = new Observer(station.latitude, station.longitude, station.elevationM),
    limit = (end.toMillis() - start.toMillis()) / 86400000;
  const event = (result) =>
    result && result.date.getTime() < end.toMillis() ? result.date.toISOString() : null;
  const result = {
    date,
    timezone: 'Europe/Oslo',
    method: 'astronomy-engine-2.1.19',
    sunrise: event(SearchRiseSet(Body.Sun, observer, 1, start.toJSDate(), limit)),
    sunset: event(SearchRiseSet(Body.Sun, observer, -1, start.toJSDate(), limit)),
    civilDawn: event(SearchAltitude(Body.Sun, observer, 1, start.toJSDate(), limit, -6)),
    civilDusk: event(SearchAltitude(Body.Sun, observer, -1, start.toJSDate(), limit, -6)),
    moonrise: event(SearchRiseSet(Body.Moon, observer, 1, start.toJSDate(), limit)),
    moonset: event(SearchRiseSet(Body.Moon, observer, -1, start.toJSDate(), limit)),
    moonPhaseDegrees: MoonPhase(start.plus({ hours: 12 }).toJSDate()),
    moonIlluminatedFraction: Illumination(Body.Moon, start.plus({ hours: 12 }).toJSDate()).phase_fraction,
  };
  cache.set(key, result);
  if (cache.size > 128) cache.delete(cache.keys().next().value);
  return result;
}
