import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SessionOwnerReminderController,
  deriveSessionOwnerReminderStates,
  normalizeSessionOwnerReminderConfig,
  sessionOwnerReminderDeliveryUuid,
  type SessionOwnerReminderConfig,
  type SessionOwnerReminderRecord,
} from '../src/core/session-owner-reminder.js';
import { buildSessionOwnerMention } from '../src/services/session-owner-notification.js';
import {
  loadSessionOwnerReminderRecords,
  saveSessionOwnerReminderRecords,
  sessionOwnerReminderStorePath,
} from '../src/services/session-owner-reminder-store.js';

function session(overrides: Record<string, unknown> = {}): any {
  const base: any = {
    session: {
      sessionId: 's1',
      status: 'active',
      scope: 'thread',
      ownerOpenId: 'ou_owner',
      rootMessageId: 'om_root',
    },
    larkAppId: 'cli_bot',
    chatId: 'oc_chat',
    scope: 'thread',
    worker: { killed: false },
    lastScreenStatus: 'idle',
    lastMessageAt: 1_000,
  };
  return Object.assign(base, overrides);
}

const enabled = {
  enabled: true,
  intervalMinutes: 30,
  text: '请继续跟进。',
  states: ['idle'] as const,
};

function scheduled(
  windows: SessionOwnerReminderConfig['weeklyWindows'],
  intervalMinutes = 30,
): SessionOwnerReminderConfig {
  return { ...enabled, states: [...enabled.states], intervalMinutes, weeklyWindows: windows };
}

describe('session owner reminder configuration', () => {
  it('normalizes a valid per-Bot configuration and rejects unsafe mention markup', () => {
    expect(normalizeSessionOwnerReminderConfig(enabled)).toEqual(enabled);
    expect(normalizeSessionOwnerReminderConfig({
      ...enabled,
      text: '<at user_id="ou_other"></at> ping',
    })).toBeUndefined();
  });

  it('builds the same owner mention used by Locate and a stable cycle delivery id', () => {
    expect(buildSessionOwnerMention('ou_owner')).toBe('<at user_id="ou_owner"></at>');
    expect(buildSessionOwnerMention('ou_owner', '请继续跟进。'))
      .toBe('<at user_id="ou_owner"></at> 请继续跟进。');
    expect(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000))
      .toBe(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000));
    expect(sessionOwnerReminderDeliveryUuid('s1', 'idle', 1_000))
      .not.toBe(sessionOwnerReminderDeliveryUuid('s1', 'idle', 2_000));
  });
});

describe('session owner reminder state projection', () => {
  it('projects every independently selectable runtime signal', () => {
    const ds = session({
      lastScreenStatus: 'limited',
      tuiPromptCardId: 'om_prompt',
      agentAttention: { kind: 'blocked', reason: 'need input', at: 2_000 },
    });
    expect(deriveSessionOwnerReminderStates(ds)).toEqual([
      'tui_prompt',
      'agent_attention',
      'limited',
    ]);
    expect(deriveSessionOwnerReminderStates(session({ worker: null, pendingRepo: true }))).toEqual(['pending_repo']);
    expect(deriveSessionOwnerReminderStates(session({ worker: null, lastScreenStatus: 'limited' }))).toEqual(['dormant']);
  });
});

describe('SessionOwnerReminderController', () => {
  it('waits one interval, repeats, and resets after inbound activity', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const ds = session();

    await controller.scan([ds], enabled, 10_000);
    await controller.scan([ds], enabled, 10_000 + 30 * 60_000 - 1);
    expect(send).not.toHaveBeenCalled();

    await controller.scan([ds], enabled, 10_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(
      ds,
      '请继续跟进。',
      expect.stringMatching(/^owner-reminder-/),
      'ou_owner',
    );

    await controller.scan([ds], enabled, 10_000 + 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);

    ds.lastMessageAt = 10_000 + 61 * 60_000;
    await controller.scan([ds], enabled, 10_000 + 61 * 60_000);
    await controller.scan([ds], enabled, 10_000 + 90 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    await controller.scan([ds], enabled, 10_000 + 91 * 60_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('resets the quiet period when any projected runtime state changes', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const ds = session();
    await controller.scan([ds], enabled, 1_000);
    ds.tuiPromptCardId = 'om_prompt'; // unselected, but still a state transition
    await controller.scan([ds], enabled, 1_000 + 30 * 60_000);
    expect(send).not.toHaveBeenCalled();
    await controller.scan([ds], enabled, 1_000 + 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('filters non-thread and unselected states and backs off failed sends', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockRejectedValueOnce(new Error('lark unavailable')).mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
    });
    const due = session();
    const chatScope = session({ session: { ...session().session, sessionId: 'chat', scope: 'chat' }, scope: 'chat' });
    const working = session({ session: { ...session().session, sessionId: 'working' }, lastScreenStatus: 'working' });

    await controller.scan([due, chatScope, working], enabled, 1_000);
    await controller.scan([due, chatScope, working], enabled, 1_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(Object.keys(records)).toEqual(['s1']);

    await controller.scan([due], enabled, 1_000 + 30 * 60_000 + 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    await controller.scan([due], enabled, 1_000 + 35 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
  });

  it('keeps overdue records outside the window and sends only once when it opens', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    let now = Date.parse('2026-08-17T00:00:00Z'); // Monday 08:00 Asia/Shanghai
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
      now: () => now,
      timeZone: () => 'Asia/Shanghai',
    });
    const config = scheduled({
      mon: [{ start: '10:30', end: '21:30' }],
      tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
    }, 30);
    const ds = session({ lastMessageAt: now - 60_000 });

    await controller.scan([ds], config);
    now += 2 * 60 * 60_000;
    await controller.scan([ds], config);
    expect(send).not.toHaveBeenCalled();
    expect(records.s1).toMatchObject({ actionableSince: Date.parse('2026-08-17T00:00:00Z') });

    now = Date.parse('2026-08-17T02:30:00Z');
    await controller.scan([ds], config);
    expect(send).toHaveBeenCalledTimes(1);
    await controller.scan([ds], config);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rechecks the window after a slow send crosses the closing boundary', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {
      first: {
        sessionId: 'first', stateFingerprint: 'idle', actionableSince: 1,
        lastObservedActivityAt: 0,
      },
      second: {
        sessionId: 'second', stateFingerprint: 'idle', actionableSince: 1,
        lastObservedActivityAt: 0,
      },
    };
    let now = Date.parse('2026-08-17T13:29:00Z'); // Monday 21:29 Asia/Shanghai
    const send = vi.fn().mockImplementation(async () => { now += 60_000; });
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
      now: () => now,
      timeZone: () => 'Asia/Shanghai',
    });
    const config = scheduled({
      mon: [{ start: '10:30', end: '21:30' }],
      tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
    }, 1);
    const first = session({ session: { ...session().session, sessionId: 'first' }, lastMessageAt: 0 });
    const second = session({ session: { ...session().session, sessionId: 'second' }, lastMessageAt: 0 });

    await controller.scan([first, second], config);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].session.sessionId).toBe('first');
    expect(records.second.lastRemindedAt).toBeUndefined();
  });

  it('reset invalidates an in-flight scan so old records cannot be restored', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {
      s1: {
        sessionId: 's1', stateFingerprint: 'idle', actionableSince: 1,
        lastObservedActivityAt: 0,
      },
    };
    let releaseSend: (() => void) | undefined;
    const send = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { releaseSend = resolve; }));
    const controller = new SessionOwnerReminderController({
      load: () => structuredClone(records),
      save: next => { records = structuredClone(next); },
      send,
      canSend: () => true,
      now: () => 120_000,
      timeZone: () => 'UTC',
    });

    const scan = controller.scan([session({ lastMessageAt: 0 })], scheduled(undefined, 1));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    controller.reset();
    expect(records).toEqual({});
    releaseSend?.();
    await scan;
    expect(records).toEqual({});
  });

  it('filters every ineligible session shape and clears records when disabled', async () => {
    let records: Record<string, SessionOwnerReminderRecord> = {};
    const send = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionOwnerReminderController({
      load: () => records,
      save: next => { records = structuredClone(next); },
      send,
      canSend: ds => ds.chatId !== 'http_async_1' && ds.larkAppId !== 'api_only',
    });
    const eligiblePty = session({ backend: { type: 'pty' } });
    const eligibleTmux = session({
      session: { ...session().session, sessionId: 'tmux' },
      backend: { type: 'tmux' },
    });
    const queued = session({ session: { ...session().session, sessionId: 'queued', queued: true } });
    const ownerless = session({ session: { ...session().session, sessionId: 'ownerless', ownerOpenId: undefined } });
    const lastCallerFallback = session({
      session: {
        ...session().session,
        sessionId: 'last-caller',
        ownerOpenId: undefined,
        lastCallerOpenId: 'ou_last_caller',
      },
    });
    const closed = session({ session: { ...session().session, sessionId: 'closed', status: 'closed' } });
    const noTransport = session({
      session: { ...session().session, sessionId: 'http' },
      chatId: 'http_async_1',
    });
    const apiOnly = session({
      session: { ...session().session, sessionId: 'api' },
      larkAppId: 'api_only',
    });

    const all = [eligiblePty, eligibleTmux, queued, ownerless, lastCallerFallback, closed, noTransport, apiOnly];
    await controller.scan(all, enabled, 1_000);
    await controller.scan(all, enabled, 1_000 + 30 * 60_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(call => call[0].session.sessionId)).toEqual(['s1', 'tmux', 'last-caller']);
    expect(send.mock.calls.map(call => call[3])).toEqual(['ou_owner', 'ou_owner', 'ou_last_caller']);
    expect(Object.keys(records).sort()).toEqual(['last-caller', 's1', 'tmux']);

    await controller.scan(all, { ...enabled, enabled: false }, 1_000 + 31 * 60_000);
    expect(records).toEqual({});
  });
});

describe('session owner reminder durable store', () => {
  it('round-trips valid records with private permissions and ignores corrupt input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-owner-reminder-'));
    try {
      const records = {
        s1: {
          sessionId: 's1',
          stateFingerprint: 'idle',
          actionableSince: 1_000,
          lastObservedActivityAt: 900,
          lastRemindedAt: 2_000,
        },
      };
      saveSessionOwnerReminderRecords(dir, 'cli_app', records);
      expect(loadSessionOwnerReminderRecords(dir, 'cli_app')).toEqual(records);
      expect(readFileSync(sessionOwnerReminderStorePath(dir, 'cli_app'), 'utf8')).toContain('"stateFingerprint": "idle"');

      writeFileSync(sessionOwnerReminderStorePath(dir, 'cli_app'), '{broken');
      expect(loadSessionOwnerReminderRecords(dir, 'cli_app')).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
