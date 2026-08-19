import {
  sessionOwnerReminderTimeToMinute,
  type SessionOwnerReminderWeekday,
  type SessionOwnerReminderWeeklyWindows,
} from './session-owner-reminder-config.js';

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: SessionOwnerReminderWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

export function zonedWallClock(
  timeZone: string,
  utcMs: number,
): { weekday: SessionOwnerReminderWeekday; minuteOfDay: number } {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const calendarDay = new Date(Date.UTC(fields.year, fields.month - 1, fields.day)).getUTCDay();
  return {
    weekday: WEEKDAYS[calendarDay],
    minuteOfDay: fields.hour * 60 + fields.minute,
  };
}

export function isSessionOwnerReminderWindowOpen(
  weeklyWindows: SessionOwnerReminderWeeklyWindows | undefined,
  timeZone: string,
  utcMs: number,
): boolean {
  if (!weeklyWindows) return true;
  const { weekday, minuteOfDay } = zonedWallClock(timeZone, utcMs);
  return weeklyWindows[weekday].some(range => (
    sessionOwnerReminderTimeToMinute(range.start) <= minuteOfDay
    && minuteOfDay < sessionOwnerReminderTimeToMinute(range.end)
  ));
}
