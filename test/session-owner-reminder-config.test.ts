import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_OWNER_REMINDER,
  DEFAULT_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS,
  LEGACY_ALL_DAY_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS,
  normalizeSessionOwnerReminderConfig,
  validateSessionOwnerReminderConfig,
} from '../src/core/session-owner-reminder-config.js';

const base = {
  enabled: true,
  intervalMinutes: 30,
  text: '请继续跟进。',
  states: ['idle'] as const,
};

describe('session owner reminder weekly window configuration', () => {
  it('defaults new configurations to weekday daytime windows and keeps legacy schedules all day', () => {
    expect(DEFAULT_SESSION_OWNER_REMINDER.weeklyWindows).toEqual({
      mon: [{ start: '10:30', end: '21:30' }],
      tue: [{ start: '10:30', end: '21:30' }],
      wed: [{ start: '10:30', end: '21:30' }],
      thu: [{ start: '10:30', end: '21:30' }],
      fri: [{ start: '10:30', end: '21:30' }],
      sat: [],
      sun: [],
    });
    expect(DEFAULT_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS).toEqual(
      DEFAULT_SESSION_OWNER_REMINDER.weeklyWindows,
    );
    expect(LEGACY_ALL_DAY_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS).toEqual({
      mon: [{ start: '00:00', end: '24:00' }],
      tue: [{ start: '00:00', end: '24:00' }],
      wed: [{ start: '00:00', end: '24:00' }],
      thu: [{ start: '00:00', end: '24:00' }],
      fri: [{ start: '00:00', end: '24:00' }],
      sat: [{ start: '00:00', end: '24:00' }],
      sun: [{ start: '00:00', end: '24:00' }],
    });

    expect(normalizeSessionOwnerReminderConfig(base)).toEqual(base);
  });

  it('accepts minute ranges in input order, including overlap and 24:00', () => {
    const weeklyWindows = {
      mon: [
        { start: '14:00', end: '21:30' },
        { start: '10:30', end: '15:00' },
        { start: '10:30', end: '15:00' },
      ],
      tue: [{ start: '00:00', end: '24:00' }],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    };

    expect(normalizeSessionOwnerReminderConfig({ ...base, weeklyWindows })).toEqual({
      ...base,
      weeklyWindows,
    });
  });

  it('reports the weekday, range and field for an invalid cross-midnight range', () => {
    const result = validateSessionOwnerReminderConfig({
      ...base,
      weeklyWindows: {
        mon: [],
        tue: [],
        wed: [{ start: '22:00', end: '02:00' }],
        thu: [],
        fri: [],
        sat: [],
        sun: [],
      },
    });

    expect(result).toEqual({
      ok: false,
      code: 'range_order_invalid',
      weekday: 'wed',
      rangeIndex: 0,
      field: 'end',
    });
  });

  it('rejects non-plain objects and inherited range fields', () => {
    class Config {}
    expect(validateSessionOwnerReminderConfig(Object.assign(new Config(), base))).toEqual({
      ok: false,
      code: 'invalid_object',
    });

    const inherited = Object.create({ start: '10:30', end: '21:30' });
    expect(validateSessionOwnerReminderConfig({
      ...base,
      weeklyWindows: {
        mon: [inherited], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
      },
    })).toEqual({ ok: false, code: 'range_invalid', weekday: 'mon', rangeIndex: 0 });
  });

  it('keeps exported defaults immutable', () => {
    expect(() => {
      (DEFAULT_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS.mon as any[]).push({ start: '01:00', end: '02:00' });
    }).toThrow();
    expect(() => {
      (DEFAULT_SESSION_OWNER_REMINDER.weeklyWindows!.mon[0] as any).start = '00:00';
    }).toThrow();
    expect(DEFAULT_SESSION_OWNER_REMINDER.weeklyWindows!.mon[0].start).toBe('10:30');
  });

  it('rejects more than 24 ranges and enabled schedules with no allowed window', () => {
    const emptyWeek = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    expect(validateSessionOwnerReminderConfig({ ...base, weeklyWindows: emptyWeek })).toEqual({
      ok: false,
      code: 'weekly_windows_empty',
    });

    expect(validateSessionOwnerReminderConfig({
      ...base,
      weeklyWindows: {
        ...emptyWeek,
        mon: Array.from({ length: 25 }, () => ({ start: '10:30', end: '21:30' })),
      },
    })).toEqual({
      ok: false,
      code: 'too_many_ranges',
      weekday: 'mon',
    });

    expect(normalizeSessionOwnerReminderConfig({
      ...base,
      enabled: false,
      weeklyWindows: emptyWeek,
    })).toEqual({ ...base, enabled: false, weeklyWindows: emptyWeek });
  });
});
