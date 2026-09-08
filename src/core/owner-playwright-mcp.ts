import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionPluginManifestPath } from './plugins/session-manifest.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { CredentialBindMount } from './owner.js';

export type OwnerPlaywrightMcpPlan =
  | { status: 'not_applicable' }
  | { status: 'missing'; reason: 'mcp_command_not_found' }
  | {
      status: 'configured';
      claudeArgs: string[];
      configPath: string;
      execPaths: string[];
      readonlyRoots: string[];
      profileDir: string;
      outputDir: string;
    };

/** Register Playwright only for a Claude process that shares the frozen owner
 * mount. The generated file is session-scoped; browser state/output stays in
 * the owner bind target and is therefore reusable across that owner's bots. */
export function prepareOwnerPlaywrightMcp(opts: {
  sessionId: string;
  dataDir: string;
  claudeFamily: boolean;
  freshProcess: boolean;
  ownerCredentialIsolation: boolean;
  wrapperCli?: string;
  mounts: readonly CredentialBindMount[];
  resolveCommand(command: string): string | null;
}): OwnerPlaywrightMcpPlan {
  const mount = opts.mounts.find(candidate => candidate.id === 'playwright' && candidate.kind === 'directory');
  if (!opts.claudeFamily || !opts.freshProcess || !opts.ownerCredentialIsolation || opts.wrapperCli?.trim() || !mount) {
    return { status: 'not_applicable' };
  }

  const canonical = (path: string) => {
    try { return realpathSync(path); } catch { return path; }
  };
  const mcpCommand = opts.resolveCommand('playwright-mcp');
  if (!mcpCommand) return { status: 'missing', reason: 'mcp_command_not_found' };
  const browserCommand = opts.resolveCommand('google-chrome') ?? opts.resolveCommand('chromium');

  const command = canonical(mcpCommand);
  const browser = browserCommand ? canonical(browserCommand) : undefined;
  // ponytail: one persistent profile preserves owner-level cross-bot login
  // reuse. Chrome safely rejects concurrent users of it; add an owner-scoped
  // MCP broker only if same-owner concurrent browsing becomes a requirement.
  const profileDir = join(mount.target, 'profile');
  const outputDir = join(mount.target, 'sessions', opts.sessionId);
  const lexicalConfigPath = join(dirname(sessionPluginManifestPath(opts.sessionId, opts.dataDir)), 'playwright-mcp.json');
  mkdirSync(dirname(lexicalConfigPath), { recursive: true });
  atomicWriteFileSync(lexicalConfigPath, `${JSON.stringify({
    browser: {
      browserName: 'chromium',
      userDataDir: profileDir,
      launchOptions: {
        channel: 'chrome',
        ...(browser ? { executablePath: browser } : {}),
        headless: true,
        args: ['--disable-features=LocalNetworkAccessChecks'],
      },
      contextOptions: { viewport: { width: 1440, height: 900 } },
    },
    sharedBrowserContext: false,
    capabilities: ['devtools'],
    timeouts: { action: 10_000, navigation: 120_000 },
    outputDir,
    saveSession: true,
  }, null, 2)}\n`, { mode: 0o600, followTargetSymlink: false });
  const configPath = canonical(lexicalConfigPath);

  const execPaths = [dirname(command), ...(browser ? [dirname(browser)] : [])];
  if (command.includes('/node_modules/')) execPaths.push(dirname(dirname(command)));
  return {
    status: 'configured',
    claudeArgs: ['--mcp-config', JSON.stringify({
      mcpServers: {
        playwright: { type: 'stdio', command, args: ['--config', configPath], env: {} },
      },
    })],
    configPath,
    execPaths,
    readonlyRoots: [configPath],
    profileDir,
    outputDir,
  };
}
