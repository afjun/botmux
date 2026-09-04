#!/usr/bin/env node
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatCredentialTrace, type CredentialTraceFields } from './credential-isolation-log.js';

export interface CredentialBootstrapRunnerSpec {
  id: string;
  command: string;
  args: string[];
  successPaths: string[];
  checkCommand?: { command: string; args: string[] };
  timeoutSeconds: number;
  lockPath: string;
}

let activeChildPid: number | undefined;
const ownedLockPaths = new Set<string>();
let shuttingDown = false;

function trace(event: string, fields: CredentialTraceFields = {}): void {
  process.stdout.write(`\n${formatCredentialTrace(event, {
    sessionId: process.env.BOTMUX_SESSION_ID,
    botId: process.env.BOTMUX_LARK_APP_ID,
    ...fields,
  })}\n`);
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

function cleanupOwnedLocks(): void {
  const count = ownedLockPaths.size;
  for (const lockPath of ownedLockPaths) {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
  ownedLockPaths.clear();
  if (count > 0) trace('bootstrap.locks_cleaned', { result: 'released', count });
}

function installSignalCleanup(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      trace('bootstrap.signal_received', { result: 'stopping', reason: signal });
      terminateProcessGroup(activeChildPid, signal);
      cleanupOwnedLocks();
      process.exit(128);
    });
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function bootstrapSuccessPathsReady(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(path => existsSync(path));
}

interface CredentialCommandResult {
  ok: boolean;
  outcome: 'success' | 'spawn_error' | 'timeout' | 'exit_nonzero' | 'signal';
  durationMs: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<CredentialCommandResult> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(command, args, { stdio: 'inherit', detached: true });
    activeChildPid = child.pid;
    let settled = false;
    const finish = (result: Omit<CredentialCommandResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      if (activeChildPid === child.pid) activeChildPid = undefined;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 2_000).unref();
      finish({ ok: false, outcome: 'timeout' });
    }, timeoutMs);
    child.once('error', () => finish({ ok: false, outcome: 'spawn_error' }));
    child.once('exit', (code, signal) => finish(signal
      ? { ok: false, outcome: 'signal', signal }
      : code === 0
        ? { ok: true, outcome: 'success', exitCode: 0 }
        : { ok: false, outcome: 'exit_nonzero', exitCode: code ?? undefined }));
  });
}

async function acquireOrWait(spec: CredentialBootstrapRunnerSpec): Promise<'acquired' | 'timeout'> {
  const deadline = Date.now() + spec.timeoutSeconds * 1_000;
  let waitingLogged = false;
  for (;;) {
    try {
      closeSync(openSync(spec.lockPath, 'wx', 0o600));
      ownedLockPaths.add(spec.lockPath);
      trace('bootstrap.lock_acquired', { mountId: spec.id, result: 'acquired' });
      return 'acquired';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!waitingLogged) {
        waitingLogged = true;
        trace('bootstrap.lock_waiting', {
          mountId: spec.id,
          result: 'waiting',
          timeoutSeconds: spec.timeoutSeconds,
        });
      }
    }
    if (Date.now() >= deadline) {
      trace('bootstrap.lock_timeout', {
        mountId: spec.id,
        result: 'timeout',
        timeoutSeconds: spec.timeoutSeconds,
      });
      return 'timeout';
    }
    await wait(1_000);
  }
}

async function bootstrapReady(spec: CredentialBootstrapRunnerSpec): Promise<boolean> {
  if (!bootstrapSuccessPathsReady(spec.successPaths)) return false;
  return spec.checkCommand
    ? (await runCommand(spec.checkCommand.command, spec.checkCommand.args, 30_000)).ok
    : true;
}

export async function runCredentialBootstraps(specs: readonly CredentialBootstrapRunnerSpec[]): Promise<boolean> {
  trace('bootstrap.batch_started', { result: 'started', count: specs.length });
  for (const spec of specs) {
    if (await bootstrapReady(spec)) {
      trace('bootstrap.skipped', {
        mountId: spec.id,
        result: 'already_ready',
        count: spec.successPaths.length,
        hasCheck: !!spec.checkCommand,
        fresh: false,
      });
      continue;
    }
    trace('bootstrap.required', {
      mountId: spec.id,
      result: 'login_required',
      count: spec.successPaths.length,
      timeoutSeconds: spec.timeoutSeconds,
      hasCheck: !!spec.checkCommand,
    });
    const lock = await acquireOrWait(spec);
    if (lock === 'timeout') {
      process.stdout.write(`\n[botmux] 凭证初始化等待超时：${spec.id}。请使用 /restart 重试。\n`);
      return false;
    }
    try {
      // Another session may have completed login immediately before this one
      // acquired the lock. Re-check both paths and optional account status.
      if (await bootstrapReady(spec)) {
        trace('bootstrap.skipped', {
          mountId: spec.id,
          result: 'completed_by_other_session',
          count: spec.successPaths.length,
          hasCheck: !!spec.checkCommand,
          fresh: false,
        });
        continue;
      }
      process.stdout.write(`\n[botmux] 正在初始化 ${spec.id} 登录。登录链接、设备码或二维码会显示在此终端。\n`);
      trace('bootstrap.command_started', {
        mountId: spec.id,
        result: 'started',
        timeoutSeconds: spec.timeoutSeconds,
      });
      const commandResult = await runCommand(spec.command, spec.args, spec.timeoutSeconds * 1_000);
      const pathsOk = bootstrapSuccessPathsReady(spec.successPaths);
      const checkResult = commandResult.ok && pathsOk && spec.checkCommand
        ? await runCommand(spec.checkCommand.command, spec.checkCommand.args, 30_000)
        : undefined;
      const checkOk = commandResult.ok && pathsOk && (checkResult?.ok ?? true);
      const failedCommand = !commandResult.ok ? commandResult : checkResult && !checkResult.ok ? checkResult : undefined;
      trace('bootstrap.validation_finished', {
        mountId: spec.id,
        result: checkOk ? 'ready' : 'failed',
        reason: checkOk
          ? undefined
          : !commandResult.ok ? `login_${commandResult.outcome}`
            : !pathsOk ? 'success_path_missing'
              : `check_${checkResult?.outcome ?? 'failed'}`,
        count: spec.successPaths.length,
        hasCheck: !!spec.checkCommand,
        fresh: true,
        durationMs: commandResult.durationMs + (checkResult?.durationMs ?? 0),
        exitCode: failedCommand?.exitCode,
        signal: failedCommand?.signal,
      });
      if (!checkOk) {
        process.stdout.write(`\n[botmux] ${spec.id} 登录未完成或校验失败。请使用 /restart 重试。\n`);
        return false;
      }
      process.stdout.write(`\n[botmux] ${spec.id} 登录完成。\n`);
    } finally {
      try { unlinkSync(spec.lockPath); } catch { /* another cleanup won */ }
      ownedLockPaths.delete(spec.lockPath);
      trace('bootstrap.lock_released', { mountId: spec.id, result: 'released' });
    }
  }
  trace('bootstrap.batch_completed', { result: 'ready', count: specs.length });
  return true;
}

async function main(): Promise<void> {
  const encoded = process.argv[2];
  const cliBin = process.argv[3];
  if (!encoded || !cliBin) throw new Error('credential bootstrap runner requires spec and CLI binary');
  const specs = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CredentialBootstrapRunnerSpec[];
  installSignalCleanup();
  // The worker registers PTY listeners immediately after spawn. Leave a small
  // handshake window so a fast login command cannot print its URL before the
  // terminal observer is attached.
  await wait(750);
  if (!await runCredentialBootstraps(specs)) process.exit(78);
  process.stdout.write('\n[botmux] 凭证初始化全部完成，正在启动 CLI。\n');

  const cli = spawn(cliBin, process.argv.slice(4), { stdio: 'inherit', detached: true });
  activeChildPid = cli.pid;
  cli.once('error', error => {
    process.stderr.write(`[botmux] failed to start CLI: ${error.message}\n`);
    process.exit(127);
  });
  cli.once('exit', (code, signal) => {
    if (signal) process.exit(128);
    else process.exit(code ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(error => {
    process.stderr.write(`[botmux] credential bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(78);
  });
}
