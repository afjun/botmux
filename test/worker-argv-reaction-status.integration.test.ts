import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();
// Keep this integration test away from a pre-existing user tmux server whose
// global PATH may not contain the Node runtime used by the fake pane command.
const tmuxTmpDir = mkdtempSync(join(tmpdir(), 'botmux-worker-tmux-'));
const previousTmuxTmpDir = process.env.TMUX_TMPDIR;
process.env.TMUX_TMPDIR = tmuxTmpDir;
const tmuxAvailable = (() => {
  const probeSession = `botmux-probe-${process.pid}-${Date.now()}`;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    execFileSync('tmux', ['new-session', '-d', '-s', probeSession, 'true'], { stdio: 'ignore' });
    execFileSync('tmux', ['kill-session', '-t', probeSession], { stdio: 'ignore' });
    return true;
  } catch {
    try { execFileSync('tmux', ['kill-session', '-t', probeSession], { stdio: 'ignore' }); } catch { /* probe failed */ }
    return false;
  }
})();

afterAll(() => {
  if (previousTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = previousTmuxTmpDir;
  rmSync(tmuxTmpDir, { recursive: true, force: true });
});

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 2_000)),
  ]);
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const session of tmuxSessions) {
    try { execFileSync('tmux', ['kill-session', '-t', session]); } catch { /* already stopped */ }
  }
  tmuxSessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function waitForScreenUpdates(
  child: ChildProcess,
  messages: WorkerToDaemon[],
  count: number,
  logs: string[],
): Promise<Array<Extract<WorkerToDaemon, { type: 'screen_update' }>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const updates = messages.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'screen_update' }> =>
        message.type === 'screen_update',
    );
    if (updates.length >= count) return updates;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before ${count} screen updates\n${logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(
    `timed out waiting for ${count} screen updates: ${JSON.stringify(messages)}\n${logs.join('')}`,
  );
}

describe('worker argv reaction status', () => {
  it('keeps an argv-baked Pi turn working until its viewport loses Working...', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-busy-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HDone without transcript final\\n'), 4_500);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-busy',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: 'sid-worker-pi-busy',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'pi',
      cliPathOverride: fakePi,
      backendType: 'pty',
      prompt: 'hello from argv',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
    } satisfies DaemonToWorker);

    const deadline = Date.now() + 3_500;
    while (Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);

    const updates = await waitForScreenUpdates(child, messages, 2, logs);
    expect(updates[0]?.status).toBe('working');
    expect(updates.at(-1)?.status).toBe('idle');
  }, 15_000);

  it.skipIf(!tmuxAvailable)('keeps an adopted Pi pane working until its viewport loses Working...', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-adopt-busy-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Working...\\n');
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[HDone without transcript final\\n'), 4_500);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const tmuxSession = `botmux-adopt-pi-${process.pid}-${Date.now()}`;
    tmuxSessions.add(tmuxSession);
    execFileSync('tmux', ['new-session', '-d', '-s', tmuxSession, fakePi]);
    const adoptPaneTarget = execFileSync(
      'tmux', ['display-message', '-p', '-t', tmuxSession, '#{pane_id}'],
      { encoding: 'utf8' },
    ).trim();

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-pi-adopt-busy',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: 'sid-worker-pi-adopt-busy',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'pi',
      backendType: 'tmux',
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
      adoptMode: true,
      adoptTmuxTarget: adoptPaneTarget,
      adoptPaneCols: 160,
      adoptPaneRows: 50,
    } satisfies DaemonToWorker);

    const deadline = Date.now() + 3_500;
    while (Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(false);

    await new Promise(resolvePromise => setTimeout(resolvePromise, 4_000));
    expect(messages.some(message => message.type === 'prompt_ready'), JSON.stringify(messages)).toBe(true);
  }, 15_000);

  it('forces the synthetic working seed before classifying a limited settle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-argv-reaction-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });

    // A single rate-limit render followed by quiescence reaches the natural
    // argv first-turn completion path in ~3s. The worker must emit raw working
    // first, then classify the real idle settle as limited. If the synthetic
    // tick is classified too, both updates collapse to limited and card-off
    // GoGoGo never sees the busy edge required to flip DONE.
    const fakeGemini = join(root, 'fake-gemini');
    writeFileSync(fakeGemini, `#!/usr/bin/env node
process.stdout.write('Rate limit exceeded. Try again at 10:36 PM.\\n');
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeGemini, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-worker-argv-reaction',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: 'sid-worker-argv-reaction',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'gemini',
      cliPathOverride: fakeGemini,
      backendType: 'pty',
      prompt: 'hello from argv',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_turn',
    } satisfies DaemonToWorker);

    const updates = await waitForScreenUpdates(child, messages, 2, logs);
    expect(updates.slice(0, 2).map(message => message.status)).toEqual([
      'working',
      'limited',
    ]);
    expect(updates[0]?.usageLimit).toBeUndefined();
    expect(updates[1]?.usageLimit?.limited).toBe(true);
  }, 15_000);
});
