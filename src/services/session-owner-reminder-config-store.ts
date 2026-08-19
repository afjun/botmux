import { getBot } from '../bot-registry.js';
import {
  isPlainSessionOwnerReminderObject,
  normalizeSessionOwnerReminderConfig,
  type SessionOwnerReminderConfig,
} from '../core/session-owner-reminder.js';
import { rmwBotEntry } from './config-store.js';

export interface SessionOwnerReminderConfigUpdate {
  config: SessionOwnerReminderConfig;
  shouldReset: boolean;
}

export async function updateSessionOwnerReminderConfig(
  larkAppId: string,
  raw: unknown,
  beforeDisableCommit?: () => void,
): Promise<{ ok: true; update: SessionOwnerReminderConfigUpdate } | { ok: false; reason: string }> {
  if (!isPlainSessionOwnerReminderObject(raw)) {
    return { ok: false, reason: 'invalid_session_owner_reminder' };
  }
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const request = raw as Record<string, unknown>;
  const result = await rmwBotEntry<{
    config: SessionOwnerReminderConfig;
    shouldReset: boolean;
  } | undefined>(larkAppId, (entry) => {
    const current = normalizeSessionOwnerReminderConfig(entry.sessionOwnerReminder);
    const candidate = Object.prototype.hasOwnProperty.call(request, 'weeklyWindows')
      ? request
      : {
        ...request,
        ...(current?.weeklyWindows ? { weeklyWindows: current.weeklyWindows } : {}),
      };
    const normalized = normalizeSessionOwnerReminderConfig(candidate);
    if (!normalized) return { write: false, result: undefined };
    entry.sessionOwnerReminder = normalized;
    const shouldReset = current?.enabled === true && !normalized.enabled;
    if (shouldReset) beforeDisableCommit?.();
    return {
      write: true,
      result: { config: normalized, shouldReset },
    };
  }, (update) => {
    if (update) bot.config.sessionOwnerReminder = update.config;
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  if (!result.result) return { ok: false, reason: 'invalid_session_owner_reminder' };

  return { ok: true, update: result.result };
}
