import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';
export {
  DEFAULT_SESSION_OWNER_REMINDER,
  DEFAULT_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS,
  LEGACY_ALL_DAY_SESSION_OWNER_REMINDER_WEEKLY_WINDOWS,
  SESSION_OWNER_REMINDER_SCHEMA_VERSION,
  SESSION_OWNER_REMINDER_STATES,
  SESSION_OWNER_REMINDER_WEEKDAYS,
  buildSessionOwnerReminderCapability,
  isPlainSessionOwnerReminderObject,
  normalizeSessionOwnerReminderCapability,
  normalizeSessionOwnerReminderConfig,
  validateSessionOwnerReminderConfig,
} from './session-owner-reminder-config.js';
export type {
  SessionOwnerReminderCapability,
  SessionOwnerReminderConfig,
  SessionOwnerReminderState,
  SessionOwnerReminderTimeRange,
  SessionOwnerReminderValidationResult,
  SessionOwnerReminderWeekday,
  SessionOwnerReminderWeeklyWindows,
} from './session-owner-reminder-config.js';
import {
  type SessionOwnerReminderConfig,
  type SessionOwnerReminderState,
} from './session-owner-reminder-config.js';
import { isSessionOwnerReminderWindowOpen } from './session-owner-reminder-window.js';

export interface SessionOwnerReminderRecord {
  sessionId: string;
  stateFingerprint: string;
  actionableSince: number;
  lastObservedActivityAt: number;
  lastRemindedAt?: number;
  retryAfterAt?: number;
}

export type SessionOwnerReminderRecords = Record<string, SessionOwnerReminderRecord>;

const FAILURE_RETRY_MAX_MS = 5 * 60_000;

export function deriveSessionOwnerReminderStates(ds: DaemonSession): SessionOwnerReminderState[] {
  const states: SessionOwnerReminderState[] = [];
  const workerAlive = !!ds.worker && !ds.worker.killed;
  if (workerAlive && ds.lastScreenStatus === 'idle') states.push('idle');
  // A pre-spawn repository picker is its own actionable state, not a released
  // CLI. Likewise stale screen status belongs to the old worker lifetime.
  if (!workerAlive && !ds.pendingRepo) states.push('dormant');
  if (ds.pendingRepo) states.push('pending_repo');
  if (ds.tuiPromptCardId) states.push('tui_prompt');
  if (ds.agentAttention) states.push('agent_attention');
  if (workerAlive && ds.lastScreenStatus === 'limited') states.push('limited');
  return states;
}

export interface SessionOwnerReminderControllerDeps {
  load(): SessionOwnerReminderRecords;
  save(records: SessionOwnerReminderRecords): void;
  send(ds: DaemonSession, text: string, uuid: string, recipientOpenId: string): Promise<void>;
  canSend(ds: DaemonSession): boolean;
  now?(): number;
  timeZone?(): string;
  onError?(ds: DaemonSession, error: unknown): void;
}

function recordsSnapshot(value: unknown): string {
  return JSON.stringify(value);
}

export function sessionOwnerReminderDeliveryUuid(
  sessionId: string,
  stateFingerprint: string,
  dueBase: number,
): string {
  const digest = createHash('sha256')
    .update(`${sessionId}\0${stateFingerprint}\0${dueBase}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `owner-reminder-${digest}`;
}

/** Durable, deterministic scan engine. Scheduling and Lark IO are injected. */
export class SessionOwnerReminderController {
  private generation = 0;

  constructor(private readonly deps: SessionOwnerReminderControllerDeps) {}

  reset(): void {
    this.generation++;
    this.deps.save({});
  }

  async scan(
    sessions: Iterable<DaemonSession>,
    config: SessionOwnerReminderConfig,
    nowOverride?: number,
  ): Promise<void> {
    const scanGeneration = this.generation;
    const readNow = nowOverride === undefined ? (this.deps.now ?? Date.now) : () => nowOverride;
    let timeZone: string | undefined;
    const current = this.deps.load();
    const before = recordsSnapshot(current);
    if (!config.enabled || config.states.length === 0) {
      if (Object.keys(current).length > 0) this.deps.save({});
      return;
    }

    const configured = new Set(config.states);
    const seen = new Set<string>();
    const intervalMs = config.intervalMinutes * 60_000;

    for (const ds of sessions) {
      const now = readNow();
      const sessionId = ds.session.sessionId;
      const recipientOpenId = ds.session.ownerOpenId ?? ds.session.lastCallerOpenId;
      if (ds.session.status !== 'active'
        || ds.session.queued === true
        || (ds.scope ?? ds.session.scope) !== 'thread'
        || !recipientOpenId
        || !this.deps.canSend(ds)) {
        delete current[sessionId];
        continue;
      }

      const projectedStates = deriveSessionOwnerReminderStates(ds);
      const matched = projectedStates.filter(state => configured.has(state));
      if (matched.length === 0) {
        delete current[sessionId];
        continue;
      }
      seen.add(sessionId);
      // Eligibility follows the configured subset, but timer resets follow the
      // complete runtime state. An unselected attention signal still represents
      // a state transition and starts a fresh quiet period.
      const stateFingerprint = projectedStates.join(',');
      const activityAt = Number.isFinite(ds.lastMessageAt) ? ds.lastMessageAt : 0;
      let record = current[sessionId];

      if (!record
        || record.stateFingerprint !== stateFingerprint
        || activityAt > record.lastObservedActivityAt) {
        record = current[sessionId] = {
          sessionId,
          stateFingerprint,
          actionableSince: Math.max(now, activityAt),
          lastObservedActivityAt: activityAt,
        };
        continue;
      }

      const dueBase = record.lastRemindedAt ?? record.actionableSince;
      if (now - dueBase < intervalMs) continue;
      if (record.retryAfterAt !== undefined && now < record.retryAfterAt) continue;
      if (config.weeklyWindows) {
        const sendNow = readNow();
        timeZone ??= this.deps.timeZone?.() ?? 'UTC';
        if (!isSessionOwnerReminderWindowOpen(config.weeklyWindows, timeZone, sendNow)) continue;
      }

      try {
        await this.deps.send(
          ds,
          config.text,
          sessionOwnerReminderDeliveryUuid(sessionId, stateFingerprint, dueBase),
          recipientOpenId,
        );
        if (scanGeneration !== this.generation) return;
        record.lastRemindedAt = readNow();
        record.retryAfterAt = undefined;
      } catch (error) {
        if (scanGeneration !== this.generation) return;
        record.retryAfterAt = readNow() + Math.max(60_000, Math.min(intervalMs, FAILURE_RETRY_MAX_MS));
        this.deps.onError?.(ds, error);
      }
    }

    for (const sessionId of Object.keys(current)) {
      if (!seen.has(sessionId)) delete current[sessionId];
    }
    if (scanGeneration === this.generation && recordsSnapshot(current) !== before) {
      this.deps.save(current);
    }
  }
}
