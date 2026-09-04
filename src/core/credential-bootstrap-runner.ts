#!/usr/bin/env node
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

function cleanupOwnedLocks(): void {
  for (const lockPath of ownedLockPaths) {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
  ownedLockPaths.clear();
}

function installSignalCleanup(): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
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

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'inherit', detached: true });
    activeChildPid = child.pid;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (activeChildPid === child.pid) activeChildPid = undefined;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }, 2_000).unref();
      finish(false);
    }, timeoutMs);
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
  });
}

async function acquireOrWait(spec: CredentialBootstrapRunnerSpec): Promise<'acquired' | 'timeout'> {
  const deadline = Date.now() + spec.timeoutSeconds * 1_000;
  for (;;) {
    try {
      closeSync(openSync(spec.lockPath, 'wx', 0o600));
      ownedLockPaths.add(spec.lockPath);
      return 'acquired';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) return 'timeout';
    await wait(1_000);
  }
}

async function bootstrapReady(spec: CredentialBootstrapRunnerSpec): Promise<boolean> {
  if (!bootstrapSuccessPathsReady(spec.successPaths)) return false;
  return spec.checkCommand
    ? runCommand(spec.checkCommand.command, spec.checkCommand.args, 30_000)
    : true;
}

export async function runCredentialBootstraps(specs: readonly CredentialBootstrapRunnerSpec[]): Promise<boolean> {
  for (const spec of specs) {
    if (await bootstrapReady(spec)) continue;
    const lock = await acquireOrWait(spec);
    if (lock === 'timeout') {
      process.stdout.write(`\n[botmux] 凭证初始化等待超时：${spec.id}。请使用 /restart 重试。\n`);
      return false;
    }
    try {
      // Another session may have completed login immediately before this one
      // acquired the lock. Re-check both paths and optional account status.
      if (await bootstrapReady(spec)) continue;
      process.stdout.write(`\n[botmux] 正在初始化 ${spec.id} 登录。登录链接、设备码或二维码会显示在此终端。\n`);
      const commandOk = await runCommand(spec.command, spec.args, spec.timeoutSeconds * 1_000);
      const pathsOk = bootstrapSuccessPathsReady(spec.successPaths);
      const checkOk = commandOk && pathsOk && spec.checkCommand
        ? await runCommand(spec.checkCommand.command, spec.checkCommand.args, 30_000)
        : commandOk && pathsOk;
      if (!checkOk) {
        process.stdout.write(`\n[botmux] ${spec.id} 登录未完成或校验失败。请使用 /restart 重试。\n`);
        return false;
      }
      process.stdout.write(`\n[botmux] ${spec.id} 登录完成。\n`);
    } finally {
      try { unlinkSync(spec.lockPath); } catch { /* another cleanup won */ }
      ownedLockPaths.delete(spec.lockPath);
    }
  }
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
