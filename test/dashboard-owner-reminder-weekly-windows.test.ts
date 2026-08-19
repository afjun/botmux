import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SessionOwnerReminderSection } from '../src/dashboard/web/bot-defaults-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof (globalThis as any).HTMLDialogElement === 'undefined') {
  (globalThis as any).HTMLDialogElement = class {};
}
if (!(globalThis as any).HTMLDialogElement.prototype.showModal) {
  (globalThis as any).HTMLDialogElement.prototype.showModal = () => undefined;
  (globalThis as any).HTMLDialogElement.prototype.close = () => undefined;
}

const capability = {
  schemaVersion: 2,
  effectiveTimeZone: 'Asia/Shanghai',
  timeZoneSource: 'settings' as const,
};

function bot(overrides: Record<string, unknown> = {}): any {
  return {
    larkAppId: 'app_owner_reminder',
    larkTransportEnabled: true,
    sessionOwnerReminderCapability: capability,
    sessionOwnerReminder: {
      enabled: false,
      intervalMinutes: 30,
      text: '请继续跟进。',
      states: ['idle'],
      weeklyWindows: {
        mon: [{ start: '10:30', end: '21:30' }],
        tue: [{ start: '10:30', end: '21:30' }],
        wed: [{ start: '10:30', end: '21:30' }],
        thu: [{ start: '10:30', end: '21:30' }],
        fri: [{ start: '10:30', end: '21:30' }],
        sat: [],
        sun: [],
      },
    },
    ...overrides,
  };
}

function render(overrides: Record<string, unknown> = {}) {
  const patchBot = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(SessionOwnerReminderSection, {
      bot: bot(overrides),
      patchBot,
    }));
  });
  return { renderer, root: renderer.root, patchBot };
}

describe('SessionOwnerReminderSection weekly windows', () => {
  it('hides the entire section for bots without Lark transport', () => {
    const { renderer } = render({ larkTransportEnabled: false });
    expect(renderer.toJSON()).toBeNull();
  });

  it('renders a seven-day summary, current timezone and legacy all-day schedule', () => {
    const legacy = bot().sessionOwnerReminder;
    delete legacy.weeklyWindows;
    const { root } = render({ sessionOwnerReminder: legacy });

    expect(root.findByProps({ 'data-owner-reminder-timezone': '' }).children.join('')).toContain('Asia/Shanghai');
    const days = root.findAll(node => typeof node.props['data-owner-reminder-day'] === 'string');
    expect(days).toHaveLength(7);
    expect(days[0]!.findAllByType('span')[0]!.children.join('')).toContain('00:00');
    expect(root.findAllByProps({ 'data-owner-reminder-legacy': '' })).toHaveLength(1);
  });

  it('marks old daemons read-only instead of allowing a false-success save', () => {
    const { root } = render({ sessionOwnerReminderCapability: null });
    expect(root.findByProps({ 'data-owner-reminder-upgrade': '' })).toBeTruthy();
    expect(root.findByProps({ 'data-action': 'save-owner-reminder' }).props.disabled).toBe(true);
  });

  it('adds minute ranges and keeps 24:00 as an explicit end-of-day sentinel', () => {
    const { root } = render();
    const monday = root.findByProps({ 'data-owner-reminder-day': 'mon' });
    act(() => monday.props.onClick());
    act(() => root.findByProps({ 'data-action': 'add-owner-reminder-range' }).props.onClick());

    const ranges = root.findAll(node => typeof node.props['data-owner-reminder-range'] === 'number');
    expect(ranges).toHaveLength(2);
    const endOfDay = root.findAllByProps({ 'data-action': 'owner-reminder-end-of-day' });
    act(() => endOfDay[endOfDay.length - 1]!.props.onClick());
    expect(root.findByProps({ 'data-owner-reminder-end': '' }).children.join('')).toContain('24:00');
  });

  it('copies the source day over selected target days', () => {
    const { root } = render();
    act(() => root.findByProps({ 'data-owner-reminder-day': 'mon' }).props.onClick());
    act(() => root.findByProps({ 'data-action': 'copy-owner-reminder-day' }).props.onClick());
    act(() => root.findByProps({ 'data-copy-target': 'sat' }).props.onChange({ currentTarget: { checked: true } }));
    act(() => root.findByProps({ 'data-action': 'confirm-copy-owner-reminder-day' }).props.onClick());

    const saturday = root.findByProps({ 'data-owner-reminder-day': 'sat' });
    expect(saturday.findAllByType('span')[0]!.children.join('')).toContain('10:30');
  });

  it('shows the effective timezone source', () => {
    const { root } = render({
      sessionOwnerReminderCapability: { ...capability, timeZoneSource: 'environment' },
    });
    expect(root.findByProps({ 'data-owner-reminder-timezone': '' }).children.join('')).toContain('环境变量覆盖');
    expect(root.findByProps({ href: '#/settings' }).props.title).toContain('BOTMUX_SCHEDULE_TIMEZONE');
  });

  it('rejects malformed capability metadata from an otherwise successful echo', async () => {
    const previousFetch = globalThis.fetch;
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        sessionOwnerReminder: JSON.parse(String(init?.body)),
        sessionOwnerReminderCapability: {
          ...capability,
          schemaVersion: '2',
        },
      }),
    }) as any);
    try {
      const { root, patchBot } = render();
      await act(async () => {
        root.findByProps({ 'data-action': 'save-owner-reminder' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(patchBot).not.toHaveBeenCalled();
      expect(root.findByProps({ 'data-owner-reminder-status': '' }).children.join('')).toContain('版本过旧');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('saves complete weekly windows and accepts only a v2 server echo', async () => {
    const previousFetch = globalThis.fetch;
    const requests: any[] = [];
    (globalThis as any).fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      requests.push(payload);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          sessionOwnerReminder: payload,
          sessionOwnerReminderCapability: capability,
        }),
      } as any;
    });
    try {
      const { root, patchBot } = render();
      await act(async () => {
        root.findByProps({ 'data-action': 'save-owner-reminder' }).props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(Object.keys(requests[0].weeklyWindows)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
      expect(patchBot).toHaveBeenCalledWith('app_owner_reminder', expect.objectContaining({
        sessionOwnerReminder: expect.objectContaining({ weeklyWindows: requests[0].weeklyWindows }),
      }));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
