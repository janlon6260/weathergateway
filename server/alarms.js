import { hash } from './store.js';
import { alarmRuleSchema } from './schema.js';
import { freshIssMeasurements } from './davis-iss.js';
import { derived } from './meteo.js';

export function evaluateAlarm(previous, rule, value, at) {
  rule = alarmRuleSchema.parse(rule);
  const digest = hash(rule),
    valid = typeof value === 'number' && Number.isFinite(value);
  const state =
    previous && previous.rule_hash === digest
      ? { ...previous }
      : { active: 0, pending_since: null, clearing_since: null, last_at: at, rule_hash: digest };
  if (at < state.last_at)
    return { ...state, pending_since: null, clearing_since: null, last_at: at, event: null };
  let event = null;
  if (!rule.enabled) {
    if (state.active) event = 'disabled';
    Object.assign(state, { active: 0, pending_since: null, clearing_since: null, suspended: 0 });
  } else if (!valid && rule.comparison !== 'missing') {
    Object.assign(state, { suspended: 1, pending_since: null, clearing_since: null });
  } else {
    state.suspended = 0;
    const triggered =
      rule.comparison === 'missing'
        ? !valid
        : rule.comparison === 'above'
          ? value > rule.threshold
          : value < rule.threshold;
    const cleared =
      rule.comparison === 'missing'
        ? valid
        : rule.comparison === 'above'
          ? value <= rule.threshold - rule.hysteresis
          : value >= rule.threshold + rule.hysteresis;
    if (!state.active) {
      state.clearing_since = null;
      if (triggered) {
        state.pending_since ??= at;
        if (at - state.pending_since >= rule.delaySeconds * 1000) {
          state.active = 1;
          state.pending_since = null;
          event = 'activated';
        }
      } else state.pending_since = null;
    } else {
      state.pending_since = null;
      if (cleared) {
        state.clearing_since ??= at;
        if (at - state.clearing_since >= rule.clearDelaySeconds * 1000) {
          state.active = 0;
          state.clearing_since = null;
          event = 'cleared';
        }
      } else state.clearing_since = null;
    }
  }
  return { ...state, value: valid ? value : null, last_at: at, event };
}
export function checkAlarms(store) {
  for (const config of store.configurations('alarms:')) {
    const { stationId, rules } = store.confirmedValue(config.scope),
      station = store.confirmedValue(`station:${stationId}`);
    const row = store.db
        .prepare('SELECT body FROM observations WHERE station_id=? ORDER BY observed_at DESC LIMIT 1')
        .get(stationId),
      body = row ? JSON.parse(row.body) : null;
    const now = store.clock();
    const sensorAt = Number(
      store.db.prepare('SELECT value FROM meta WHERE key=?').get(`last_valid_sensor:${stationId}`)?.value ||
        store.db.prepare('SELECT value FROM meta WHERE key=?').get(`station_started:${stationId}`)?.value ||
        now,
    );
    const age = Math.max(0, (now - sensorAt) / 1000);
    const fresh =
      station.enabled &&
      body?.sensorContact &&
      age !== null &&
      age <= store.confirmedValue('gateway').warningSeconds;
    const measurements = fresh ? (body.iss ? freshIssMeasurements(body, now) : body.measurements) : {};
    const values = fresh ? { ...measurements, ...(body.iss ? derived(measurements) : body.derived) } : {};
    values.offlineSeconds = age;
    values.qualityFlagCount = fresh ? body.quality?.flags?.length || 0 : null;
    store.db
      .transaction(() => {
        for (const rule of rules) {
          const previous = store.db
            .prepare('SELECT * FROM alarm_state WHERE station_id=? AND rule_id=?')
            .get(stationId, rule.id);
          const next = evaluateAlarm(
            previous,
            { ...rule, enabled: rule.enabled && station.enabled },
            values[rule.metric],
            now,
          );
          store.db
            .prepare('INSERT OR REPLACE INTO alarm_state VALUES (?,?,?,?,?,?,?,?,?)')
            .run(
              stationId,
              rule.id,
              next.rule_hash,
              next.active,
              next.pending_since,
              next.clearing_since,
              next.last_at,
              next.value,
              next.suspended || 0,
            );
          if (next.event) {
            store.db
              .prepare('INSERT INTO alarm_events(station_id,rule_id,name,at,kind,value) VALUES (?,?,?,?,?,?)')
              .run(stationId, rule.id, rule.name, now, next.event, next.value);
            store.audit('alarm-engine', `alarm_${next.event}`, {
              stationId,
              ruleId: rule.id,
              value: next.value,
            });
          }
        }
        const configured = new Set(rules.map((r) => r.id));
        for (const old of store.db.prepare('SELECT * FROM alarm_state WHERE station_id=?').all(stationId))
          if (!configured.has(old.rule_id)) {
            if (old.active)
              store.db
                .prepare(
                  'INSERT INTO alarm_events(station_id,rule_id,name,at,kind,value) VALUES (?,?,?,?,?,?)',
                )
                .run(stationId, old.rule_id, 'Fjernet alarm', now, 'removed', old.value);
            store.db
              .prepare('DELETE FROM alarm_state WHERE station_id=? AND rule_id=?')
              .run(stationId, old.rule_id);
          }
      })
      .immediate();
  }
}
export function alarmStatus(store) {
  return {
    configurations: store.configurations('alarms:'),
    states: store.db.prepare('SELECT * FROM alarm_state').all(),
    events: store.db.prepare('SELECT * FROM alarm_events ORDER BY id DESC LIMIT 200').all(),
  };
}
