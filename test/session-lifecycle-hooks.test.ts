import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  emitHookEventMock,
  activeCredentialBootstrapLeasesMock,
  credentialBootstrapLeaseProcessAliveMock,
  currentCredentialBootstrapLeaseMock,
  removeCredentialBootstrapLeaseMock,
  signalCredentialBootstrapLeaseProcessMock,
} = vi.hoisted(() => ({
  emitHookEventMock: vi.fn(),
  activeCredentialBootstrapLeasesMock: vi.fn(() => []),
  credentialBootstrapLeaseProcessAliveMock: vi.fn(() => false),
  currentCredentialBootstrapLeaseMock: vi.fn(),
  removeCredentialBootstrapLeaseMock: vi.fn(),
  signalCredentialBootstrapLeaseProcessMock: vi.fn(() => true),
}));

vi.mock('../src/core/credential-bootstrap-lease.js', () => ({
  activeCredentialBootstrapLeases: (...args: unknown[]) => activeCredentialBootstrapLeasesMock(...args),
  credentialBootstrapLeaseProcessAlive: (...args: unknown[]) => credentialBootstrapLeaseProcessAliveMock(...args),
  currentCredentialBootstrapLease: (...args: unknown[]) => currentCredentialBootstrapLeaseMock(...args),
  removeCredentialBootstrapLease: (...args: unknown[]) => removeCredentialBootstrapLeaseMock(...args),
  signalCredentialBootstrapLeaseProcess: (...args: unknown[]) => signalCredentialBootstrapLeaseProcessMock(...args),
}));

vi.mock('../src/services/hook-runner.js', () => ({
  emitHookEvent: (...args: unknown[]) => emitHookEventMock(...args),
}));

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
  buildTuiPromptCard: vi.fn(() => '{"type":"tui"}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{"type":"tui-resolved"}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => 'EventBus'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  __testOnly_resetSessionLifecycleHooks,
  emitSessionLifecycleHook,
  emitSessionStateTransitionHook,
  setSessionLifecycleShutdown,
} from '../src/services/session-lifecycle-hooks.js';
import {
  detachWorkerForTransfer,
  initWorkerPool,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import type { DaemonSession } from '../src/core/types.js';

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 12345;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-lifecycle-test',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Lifecycle Test',
      status: 'active',
      createdAt: new Date('2026-05-27T00:00:00.000Z').toISOString(),
      chatType: 'group',
      cliId: 'claude-code',
      workingDir: '/repo',
    },
    worker: makeFakeWorker(),
    workerPort: 9999,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1234,
    cliVersion: '1.0',
    lastMessageAt: 5678,
    hasHistory: false,
    workingDir: '/repo',
    displayMode: 'hidden',
    streamCardId: 'om_card',
    streamCardNonce: 'nonce',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Lifecycle Test',
    ...overrides,
  } as DaemonSession;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  currentCredentialBootstrapLeaseMock.mockReturnValue({
    leaseId: 'lease-current',
    sessionId: 'sid-lifecycle-test',
    sessionCreatedAt: '2026-05-27T00:00:00.000Z',
  });
  activeCredentialBootstrapLeasesMock.mockReturnValue([]);
  credentialBootstrapLeaseProcessAliveMock.mockReturnValue(false);
  signalCredentialBootstrapLeaseProcessMock.mockReturnValue(true);
  __testOnly_resetSessionLifecycleHooks();
});

describe('session lifecycle hook helper', () => {
  it('emits session.start payload with session context', () => {
    emitSessionLifecycleHook(makeDs(), 'session.start', { reason: 'new_topic' });

    expect(emitHookEventMock).toHaveBeenCalledWith('session.start', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app_test',
      scope: 'thread',
      anchor: 'om_root',
      title: 'Lifecycle Test',
      cliId: 'claude-code',
      workingDir: '/repo',
      reason: 'new_topic',
    }));
  });

  it('deduplicates repeated session.idle transitions for 10 seconds', () => {
    vi.useFakeTimers();
    const ds = makeDs();

    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(2);
  });

  it('silences session.exit while daemon shutdown is active', () => {
    setSessionLifecycleShutdown(true);

    emitSessionLifecycleHook(makeDs(), 'session.exit', { reason: 'daemon_shutdown' });

    expect(emitHookEventMock).not.toHaveBeenCalled();
  });

  it('prunes lastIdleEmits entries for the session on session.exit', () => {
    vi.useFakeTimers();
    const ds = makeDs();

    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    // session.exit should prune dedup state
    emitSessionLifecycleHook(ds, 'session.exit', { reason: 'exit_code_0' });

    // After exit prune, re-idle for same session should fire again immediately
    vi.advanceTimersByTime(0);
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'screen_update' });
    // session.exit + second idle = 3 total calls
    expect(emitHookEventMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed for dedicated VC receivers while retaining exit dedupe cleanup', () => {
    const ds = makeDs();

    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'ordinary' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    emitSessionLifecycleHook(ds, 'session.requires_attention', {
      reason: 'tui_prompt',
      description: 'meeting-derived secret',
    });
    emitSessionStateTransitionHook(ds, 'working', 'idle', {
      source: 'screen_update',
      content: 'meeting transcript',
    });
    emitSessionLifecycleHook(ds, 'session.exit', { reason: 'exit_code_1' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(1);

    // The suppressed receiver exit still pruned its old idle dedupe key.
    ds.session.vcMeetingReceiver = undefined;
    emitSessionStateTransitionHook(ds, 'working', 'idle', { source: 'ordinary-again' });
    expect(emitHookEventMock).toHaveBeenCalledTimes(2);
  });
});

describe('worker-pool lifecycle hook integration', () => {
  beforeEach(() => {
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('emits session.idle on screen_update status edges', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: 'ready', status: 'idle' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.idle', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      prevState: 'working',
      newState: 'idle',
      source: 'screen_update',
    }));
  });

  it('reuses the idle transition helper for screenshot_uploaded status edges', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img', status: 'idle' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.idle', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      prevState: 'working',
      newState: 'idle',
      source: 'screenshot_uploaded',
    }));
  });

  it('delivers credential bootstrap QR and login URL in one interactive card', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      session: {
        ...makeDs().session,
        credentialPrincipal: { ownerId: 'owner', openId: 'ou_owner' },
      },
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'credential_bootstrap_qr',
      imageKey: 'img_owner_login',
      loginUrl: 'https://login.example.com/device',
      toolName: 'bytedcli',
      leaseId: 'lease-current',
    });
    await flush();

    expect(sessionReply).toHaveBeenCalledTimes(1);
    const [, content, msgType] = sessionReply.mock.calls[0];
    expect(msgType).toBe('interactive');
    const card = JSON.parse(content);
    expect(card).toMatchObject({ schema: '2.0', body: { direction: 'vertical' } });
    expect(card.body.elements[0]).toMatchObject({
      tag: 'markdown',
      content: '请扫码登录 bytedcli',
    });
    expect(card.body.elements[1]).toMatchObject({
      tag: 'column_set',
      columns: [
        {
          width: 'weighted',
          weight: 2,
          elements: [{
            tag: 'interactive_container',
            has_border: true,
            elements: [{ tag: 'img', img_key: 'img_owner_login' }],
          }],
        },
        {
          width: 'weighted',
          weight: 6,
          elements: [{ tag: 'markdown', content: ' ' }],
        },
      ],
    });
    expect(card.body.elements[2]).toMatchObject({
      tag: 'column_set',
      columns: [{
        elements: [{
          tag: 'button',
          behaviors: [{ type: 'open_url', default_url: 'https://login.example.com/device' }],
        }],
      }],
    });
    expect(card.body.elements[3]).toEqual({ tag: 'hr' });
    expect(card.body.elements[4]).toMatchObject({
      tag: 'markdown',
      element_id: 'botmux_reply_footer',
      text_size: 'notation_small_v2',
      content: expect.stringMatching(/EventBus.*发送给：<at id=ou_owner><\/at>/),
    });
  });

  it('drops a delayed credential QR from a superseded session', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    currentCredentialBootstrapLeaseMock.mockReturnValue({
      leaseId: 'lease-new',
      sessionId: 'session-new',
      sessionCreatedAt: '2026-05-28T00:00:00.000Z',
    });
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      session: {
        ...makeDs().session,
        credentialPrincipal: { ownerId: 'owner', openId: 'ou_owner' },
      },
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'credential_bootstrap_qr', imageKey: 'img-old',
      loginUrl: 'https://login.example.com/old', toolName: 'bytedcli', leaseId: 'lease-old',
    });
    await flush();

    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('stops an older owner login when a newer session claims the lease', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      session: {
        ...makeDs().session,
        credentialPrincipal: { ownerId: 'owner', openId: 'ou_owner' },
      },
    });
    const older = {
      leaseId: 'lease-old',
      sessionId: 'session-old',
      sessionCreatedAt: '2026-05-26T00:00:00.000Z',
      runnerPid: 321,
    };
    activeCredentialBootstrapLeasesMock.mockReturnValue([older]);
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'credential_bootstrap_lease_claimed', leaseId: 'lease-current' });
    await flush();

    expect(signalCredentialBootstrapLeaseProcessMock).toHaveBeenCalledWith(older, 'SIGTERM');
  });

  it('does not restart or notify when credential login moves to a newer session', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({
      worker,
      session: { ...makeDs().session, credentialIsolation: { version: 1, mounts: [] } },
    });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'claude_exit', code: 79, signal: null, credentialBootstrapResult: 'superseded',
    });
    await flush();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(worker.send).toHaveBeenCalledWith({ type: 'close' });
  });

  it('delivers credential login success without raising requires-attention', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    ds.session.credentialPrincipal = { ownerId: 'owner', openId: 'ou_owner' };
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'credential_bootstrap_succeeded',
      message: '研发工具登录成功，bytecloud-cli 和 devflow 将复用 bytedcli 身份。',
      leaseId: 'lease-current',
    });
    await flush();

    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      '研发工具登录成功，bytecloud-cli 和 devflow 将复用 bytedcli 身份。',
      'text',
      'app_test',
      undefined,
      undefined,
    );
    expect(emitHookEventMock).not.toHaveBeenCalledWith(
      'session.requires_attention',
      expect.anything(),
    );
  });

  it('emits session.requires_attention from tui_prompt and user_notify IPC', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'tui_prompt',
      description: 'Approve command?',
      options: [{ text: 'Yes', selected: false }],
      multiSelect: false,
    });
    worker.emit('message', { type: 'user_notify', message: 'Need manual input' });
    await flush();

    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      reason: 'tui_prompt',
      description: 'Approve command?',
      optionsCount: 1,
    }));
    expect(emitHookEventMock).toHaveBeenCalledWith('session.requires_attention', expect.objectContaining({
      reason: 'user_notify',
      message: 'Need manual input',
    }));
  });

  it('routes accepted steer feedback to its exact turn without raising attention', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'steer_accepted',
      appTurnId: 'app-turn-accepted',
      turnId: 'om_exact_steer_message',
    });
    await flush();

    expect(sessionReply).toHaveBeenCalledWith(
      'om_root',
      '收到，引导成功',
      'text',
      'app_test',
      'om_exact_steer_message',
      undefined,
    );
    expect(emitHookEventMock).not.toHaveBeenCalledWith(
      'session.requires_attention',
      expect.anything(),
    );
  });

  it('ignores accepted steer feedback from a replaced worker generation', async () => {
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
    const worker = makeFakeWorker();
    const replacement = makeFakeWorker();
    const ds = makeDs({ worker: replacement });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'steer_accepted',
      appTurnId: 'app-turn-stale',
      turnId: 'om_stale',
    });
    await flush();

    expect(sessionReply).not.toHaveBeenCalled();
    expect(emitHookEventMock).not.toHaveBeenCalled();
  });

  it('does not emit lifecycle hooks for receiver TUI, notifications, status, or exit', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, lastScreenStatus: 'working' });
    ds.session.vcMeetingReceiver = {
      listenerAppId: 'listener-app',
      meetingId: 'meeting-1',
      memberId: 'member-1',
      memberEpoch: 1,
    };
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'tui_prompt',
      description: 'Approve meeting action?',
      options: [{ text: 'Yes', selected: false }],
      multiSelect: false,
    });
    worker.emit('message', { type: 'user_notify', message: 'meeting-derived diagnostic' });
    worker.emit('message', { type: 'screen_update', content: 'transcript', status: 'idle' });
    worker.emit('exit', 1);
    await flush();

    expect(emitHookEventMock).not.toHaveBeenCalled();
  });

  it('emits session.exit from worker process exit', () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('exit', 1);

    expect(emitHookEventMock).toHaveBeenCalledWith('session.exit', expect.objectContaining({
      sessionId: 'sid-lifecycle-test',
      reason: 'exit_code_1',
      code: 1,
    }));
  });

  it('suppresses external exit events for an intentional transfer detach', async () => {
    const onWorkerExit = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onWorkerExit,
    });
    const worker = makeFakeWorker();
    worker.connected = true;
    worker.exitCode = null;
    worker.signalCode = null;
    worker.send = vi.fn((
      message: { type: string; requestId?: string },
      callback?: (error: Error | null) => void,
    ) => {
      callback?.(null);
      if (message.type !== 'detach_for_transfer') return;
      queueMicrotask(() => {
        worker.emit('message', {
          type: 'transfer_detached',
          requestId: message.requestId,
        });
        worker.exitCode = 0;
        worker.emit('exit', 0, null);
      });
    });
    const ds = makeDs({ worker, lastScreenStatus: 'idle' });
    __testOnly_setupWorkerHandlers(ds, worker);

    await expect(detachWorkerForTransfer(ds, { timeoutMs: 100 })).resolves.toBe(true);

    expect(onWorkerExit).not.toHaveBeenCalled();
    expect(emitHookEventMock).not.toHaveBeenCalledWith(
      'session.exit',
      expect.anything(),
    );
    expect(dashboardEventBus.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.exited' }),
    );
  });

  it('forwards exact durable_expiry_ready evidence with worker generation', async () => {
    const onDurableExpiryReady = vi.fn();
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onDurableExpiryReady,
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', {
      type: 'durable_expiry_ready',
      sessionId: 'sid-lifecycle-test',
      turnId: 'delivery-1',
      dispatchAttempt: 3,
      disposition: 'queued_removed',
    });
    await flush();

    expect(onDurableExpiryReady).toHaveBeenCalledWith(ds, {
      sessionId: 'sid-lifecycle-test',
      turnId: 'delivery-1',
      dispatchAttempt: 3,
      workerGeneration: 1,
      disposition: 'queued_removed',
    });
  });
});
