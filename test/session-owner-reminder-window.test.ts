import { describe, expect, it } from 'vitest';
import {
  isSessionOwnerReminderWindowOpen,
  zonedWallClock,
} from '../src/core/session-owner-reminder-window.js';
import type { SessionOwnerReminderWeeklyWindows } from '../src/core/session-owner-reminder-config.js';

const windows: SessionOwnerReminderWeeklyWindows = {
  mon: [
    { start: '10:30', end: '12:00' },
    { start: '11:45', end: '21:30' },
  ],
  tue: [{ start: '00:00', end: '24:00' }],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
  sun: [{ start: '23:00', end: '24:00' }],
};

function utc(value: string): number {
  return Date.parse(value);
}

describe('session owner reminder delivery windows', () => {
  it('uses Monday-first weekdays and start-inclusive end-exclusive ranges', () => {
    expect(isSessionOwnerReminderWindowOpen(windows, 'Asia/Shanghai', utc('2026-08-17T02:29:00Z'))).toBe(false);
    expect(isSessionOwnerReminderWindowOpen(windows, 'Asia/Shanghai', utc('2026-08-17T02:30:00Z'))).toBe(true);
    expect(isSessionOwnerReminderWindowOpen(windows, 'Asia/Shanghai', utc('2026-08-17T13:29:00Z'))).toBe(true);
    expect(isSessionOwnerReminderWindowOpen(windows, 'Asia/Shanghai', utc('2026-08-17T13:30:00Z'))).toBe(false);
    expect(isSessionOwnerReminderWindowOpen(windows, 'Asia/Shanghai', utc('2026-08-16T15:00:00Z'))).toBe(true);
  });

  it('treats missing weekly windows as the legacy all-day schedule', () => {
    expect(isSessionOwnerReminderWindowOpen(undefined, 'America/Los_Angeles', utc('2026-08-19T09:00:00Z')))
      .toBe(true);
  });

  it('reports midnight as minute zero and follows the real DST wall clock', () => {
    expect(zonedWallClock('America/Los_Angeles', utc('2026-11-01T07:00:00Z'))).toEqual({
      weekday: 'sun',
      minuteOfDay: 0,
    });
    expect(zonedWallClock('America/Los_Angeles', utc('2026-11-01T08:30:00Z'))).toEqual({
      weekday: 'sun',
      minuteOfDay: 90,
    });
    expect(zonedWallClock('America/Los_Angeles', utc('2026-11-01T09:30:00Z'))).toEqual({
      weekday: 'sun',
      minuteOfDay: 90,
    });
  });
});
