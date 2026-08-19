export const SESSION_OWNER_REMINDER_STATES = [
  'idle',
  'dormant',
  'pending_repo',
  'tui_prompt',
  'agent_attention',
  'limited',
] as const;

export type SessionOwnerReminderState = typeof SESSION_OWNER_REMINDER_STATES[number];

export const SESSION_OWNER_REMINDER_WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

export type SessionOwnerReminderWeekday = typeof SESSION_OWNER_REMINDER_WEEKDAYS[number];

export type SessionOwnerReminderTimeRange = Readonly<{
  start: string;
  end: string;
}>;

export type SessionOwnerReminderWeeklyWindows = Record<
  SessionOwnerReminderWeekday,
  SessionOwnerReminderTimeRange[]
>;

export interface SessionOwnerReminderConfig {
  enabled: boolean;
  intervalMinutes: number;
  text: string;
  states: SessionOwnerReminderState[];
  /** Missing only on configurations saved before weekly windows were introduced. */
  weeklyWindows?: SessionOwnerReminderWeeklyWindows;
}

export type SessionOwnerReminderValidationResult =
  | { ok: true; config: SessionOwnerReminderConfig }
  | {
    ok: false;
    code: string;
    weekday?: SessionOwnerReminderWeekday;
    rangeIndex?: number;
    field?: 'start' | 'end';
  };

export interface SessionOwnerReminderCapability {
  schemaVersion: number;
  effectiveTimeZone: string;
  timeZoneSource: 'environment' | 'settings' | 'host';
}

export const SESSION_OWNER_REMINDER_SCHEMA_VERSION = 2;

export function buildSessionOwnerReminderCapability(
  effectiveTimeZone: string,
  timeZoneSource: SessionOwnerReminderCapability['timeZoneSource'],
): SessionOwnerReminderCapability {
  return {
    schemaVersion: SESSION_OWNER_REMINDER_SCHEMA_VERSION,
    effectiveTimeZone,
    timeZoneSource,
  };
}

export function normalizeSessionOwnerReminderCapability(
  raw: unknown,
): SessionOwnerReminderCapability | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const source = value.timeZoneSource;
  if (!Number.isInteger(value.schemaVersion)
    || typeof value.effectiveTimeZone !== 'string'
    || (source !== 'environment' && source !== 'settings' && source !== 'host')) return undefined;
  return {
    schemaVersion: value.schemaVersion as number,
    effectiveTimeZone: value.effectiveTimeZone,
    timeZoneSource: source,
  };
}

function frozenWeeklyWindows(
  value: Record<SessionOwnerReminderWeekday, SessionOwnerReminderTimeRange[]>,
): SessionOwnerReminderWeeklyWindows {
  for (const weekday of SESSION_OWNER_REMINDER_WEEKDAYS) {
    for (const range of value[weekday]) Object.freeze(range);
    Object.freeze(value[weekday]);
  }
  return Object.freeze(value);
}

function weekdayWindows(start: string, end: string): SessionOwnerReminderWeeklyWindows {
  return frozenWeeklyWindows({
    mon: [{ start, end }],
    tue: [{ start, end }],
    wed: [{ start, end }],
    thu: [{ start, end }],
    fri: [{ start, end }],
    sat: [],
    sun: [],
  });
}

export const DEFAULT_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS = weekdayWindows('10:30', '21:30');

export const LEGACY_ALL_DAY_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS = frozenWeeklyWindows({
  mon: [{ start: '00:00', end: '24:00' }],
  tue: [{ start: '00:00', end: '24:00' }],
  wed: [{ start: '00:00', end: '24:00' }],
  thu: [{ start: '00:00', end: '24:00' }],
  fri: [{ start: '00:00', end: '24:00' }],
  sat: [{ start: '00:00', end: '24:00' }],
  sun: [{ start: '00:00', end: '24:00' }],
});

export const DEFAULT_SESSION_OWNER_REMINDER: Readonly<SessionOwnerReminderConfig> = Object.freeze({
  enabled: false,
  intervalMinutes: 30,
  text: '该会话已等待处理，请继续跟进。',
  states: Object.freeze([...SESSION_OWNER_REMINDER_STATES]) as unknown as SessionOwnerReminderState[],
  weeklyWindows: DEFAULT_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS,
});

export function createDefaultSessionOwnerReminderConfig(): SessionOwnerReminderConfig {
  return structuredClone(DEFAULT_SESSION_OWNER_REMINDER) as SessionOwnerReminderConfig;
}

export const MAX_SESSION_OWNER_REMINDER_RANGES_PER_DAY = 24;
export const DEFAULT_SESSION_OWNER_REMINDER_RANGE: SessionOwnerReminderTimeRange = Object.freeze({
  start: '10:30',
  end: '21:30',
});

export function createDefaultSessionOwnerReminderRange(): SessionOwnerReminderTimeRange {
  return { ...DEFAULT_SESSION_OWNER_REMINDER_RANGE };
}

export function isPlainSessionOwnerReminderObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10_080;
const MAX_TEXT_CHARS = 500;
const START_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const END_TIME_PATTERN = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;

function isState(value: unknown): value is SessionOwnerReminderState {
  return typeof value === 'string'
    && (SESSION_OWNER_REMINDER_STATES as readonly string[]).includes(value);
}

export function sessionOwnerReminderTimeToMinute(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function invalid(
  code: string,
  details: Omit<Exclude<SessionOwnerReminderValidationResult, { ok: true }>, 'ok' | 'code'> = {},
): SessionOwnerReminderValidationResult {
  return { ok: false, code, ...details };
}

export function validateSessionOwnerReminderConfig(raw: unknown): SessionOwnerReminderValidationResult {
  if (!isPlainSessionOwnerReminderObject(raw)) return invalid('invalid_object');
  const value = raw;
  if (!Object.hasOwn(value, 'enabled') || typeof value.enabled !== 'boolean') return invalid('enabled_invalid');
  if (!Object.hasOwn(value, 'intervalMinutes')
    || !Number.isInteger(value.intervalMinutes)
    || (value.intervalMinutes as number) < MIN_INTERVAL_MINUTES
    || (value.intervalMinutes as number) > MAX_INTERVAL_MINUTES) return invalid('interval_invalid');
  if (!Object.hasOwn(value, 'text') || typeof value.text !== 'string') return invalid('text_invalid');
  const text = value.text.trim();
  if (!text || Array.from(text).length > MAX_TEXT_CHARS || /<\s*at\b/i.test(text)) {
    return invalid('text_invalid');
  }
  if (!Object.hasOwn(value, 'states') || !Array.isArray(value.states)) return invalid('states_invalid');
  const states = [...new Set(value.states.filter(isState))];
  if (states.length !== value.states.length) return invalid('states_invalid');
  if (value.enabled && states.length === 0) return invalid('states_empty');

  let weeklyWindows: Record<SessionOwnerReminderWeekday, SessionOwnerReminderTimeRange[]> | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'weeklyWindows')) {
    const rawWindows = value.weeklyWindows;
    if (!isPlainSessionOwnerReminderObject(rawWindows)) return invalid('weekly_windows_invalid');
    const windows = rawWindows;
    const keys = Object.keys(windows);
    if (keys.length !== SESSION_OWNER_REMINDER_WEEKDAYS.length
      || keys.some(key => !(SESSION_OWNER_REMINDER_WEEKDAYS as readonly string[]).includes(key))) {
      return invalid('weekly_windows_invalid');
    }

    weeklyWindows = {} as Record<SessionOwnerReminderWeekday, SessionOwnerReminderTimeRange[]>;
    let totalRanges = 0;
    for (const weekday of SESSION_OWNER_REMINDER_WEEKDAYS) {
      if (!Object.hasOwn(windows, weekday)) return invalid('weekly_windows_invalid');
      const ranges = windows[weekday];
      if (!Array.isArray(ranges)) return invalid('daily_ranges_invalid', { weekday });
      if (ranges.length > MAX_SESSION_OWNER_REMINDER_RANGES_PER_DAY) {
        return invalid('too_many_ranges', { weekday });
      }
      const normalizedRanges: SessionOwnerReminderTimeRange[] = [];
      for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
        const rawRange = ranges[rangeIndex];
        if (!isPlainSessionOwnerReminderObject(rawRange)) {
          return invalid('range_invalid', { weekday, rangeIndex });
        }
        const range = rawRange;
        if (!Object.hasOwn(range, 'start')
          || typeof range.start !== 'string'
          || !START_TIME_PATTERN.test(range.start)) {
          return invalid('range_time_invalid', { weekday, rangeIndex, field: 'start' });
        }
        if (!Object.hasOwn(range, 'end')
          || typeof range.end !== 'string'
          || !END_TIME_PATTERN.test(range.end)) {
          return invalid('range_time_invalid', { weekday, rangeIndex, field: 'end' });
        }
        if (sessionOwnerReminderTimeToMinute(range.start) >= sessionOwnerReminderTimeToMinute(range.end)) {
          return invalid('range_order_invalid', { weekday, rangeIndex, field: 'end' });
        }
        normalizedRanges.push({ start: range.start, end: range.end });
      }
      weeklyWindows[weekday] = normalizedRanges;
      totalRanges += normalizedRanges.length;
    }
    if (value.enabled && totalRanges === 0) return invalid('weekly_windows_empty');
  }

  const config: SessionOwnerReminderConfig = {
    enabled: value.enabled,
    intervalMinutes: value.intervalMinutes as number,
    text,
    states,
  };
  if (weeklyWindows) config.weeklyWindows = weeklyWindows;
  return { ok: true, config };
}

/** Strict normalizer shared by config loading and write validation. */
export function normalizeSessionOwnerReminderConfig(raw: unknown): SessionOwnerReminderConfig | undefined {
  const result = validateSessionOwnerReminderConfig(raw);
  return result.ok ? result.config : undefined;
}
