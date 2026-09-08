import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOwnerPlaywrightMcp } from '../src/core/owner-playwright-mcp.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('owner Playwright MCP', () => {
  it('injects a session-scoped server backed only by the frozen owner mount', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-owner-playwright-'));
    roots.push(dataDir);
    const ownerTarget = '/home/test/.cache/custom-playwright-owner';
    const plan = prepareOwnerPlaywrightMcp({
      sessionId: 'session-1',
      dataDir,
      claudeFamily: true,
      freshProcess: true,
      ownerCredentialIsolation: true,
      mounts: [{
        id: 'playwright', kind: 'directory', ownerSubdir: 'browser',
        source: '/owner/alice/browser', target: ownerTarget,
      }],
      resolveCommand: command => command === 'playwright-mcp'
        ? '/tools/node_modules/@playwright/mcp/cli.js'
        : command === 'google-chrome' ? '/opt/chrome/chrome' : null,
    });

    expect(plan.status).toBe('configured');
    if (plan.status !== 'configured') return;
    expect(plan.profileDir).toBe(`${ownerTarget}/profile`);
    expect(plan.outputDir).toBe(`${ownerTarget}/sessions/session-1`);
    expect(plan.configPath).toBe(join(dataDir, 'sessions', 'session-1', 'playwright-mcp.json'));
    expect(JSON.parse(plan.claudeArgs[1]!)).toMatchObject({
      mcpServers: { playwright: { command: '/tools/node_modules/@playwright/mcp/cli.js', args: ['--config', plan.configPath] } },
    });
    expect(JSON.parse(readFileSync(plan.configPath, 'utf8'))).toMatchObject({
      browser: {
        userDataDir: plan.profileDir,
        launchOptions: {
          executablePath: '/opt/chrome/chrome',
          args: ['--disable-features=LocalNetworkAccessChecks'],
        },
      },
      outputDir: `${ownerTarget}/sessions/session-1`,
      saveSession: true,
    });
  });

  it('does not affect non-Claude, reattached, non-isolated, wrapped, or unmounted sessions', () => {
    const base = {
      sessionId: 'session-2', dataDir: '/unused', freshProcess: true, mounts: [], resolveCommand: () => null,
    };
    expect(prepareOwnerPlaywrightMcp({ ...base, claudeFamily: false, ownerCredentialIsolation: true }))
      .toEqual({ status: 'not_applicable' });
    expect(prepareOwnerPlaywrightMcp({ ...base, claudeFamily: true, freshProcess: false, ownerCredentialIsolation: true }))
      .toEqual({ status: 'not_applicable' });
    expect(prepareOwnerPlaywrightMcp({ ...base, claudeFamily: true, ownerCredentialIsolation: false }))
      .toEqual({ status: 'not_applicable' });
    expect(prepareOwnerPlaywrightMcp({ ...base, claudeFamily: true, ownerCredentialIsolation: true, wrapperCli: 'runner' }))
      .toEqual({ status: 'not_applicable' });
    expect(prepareOwnerPlaywrightMcp({ ...base, claudeFamily: true, ownerCredentialIsolation: true }))
      .toEqual({ status: 'not_applicable' });
  });

  it('lets Claude start when MCP is missing and still injects without a browser preflight', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-owner-playwright-'));
    roots.push(dataDir);
    const base = {
      sessionId: 'session-3', dataDir, freshProcess: true, claudeFamily: true, ownerCredentialIsolation: true,
      mounts: [{
        id: 'playwright', kind: 'directory' as const, ownerSubdir: 'browser', source: '/owner/alice/browser', target: '/home/test/pw',
      }],
    };
    expect(prepareOwnerPlaywrightMcp({
      ...base,
      resolveCommand: () => null,
    })).toEqual({ status: 'missing', reason: 'mcp_command_not_found' });
    const configured = prepareOwnerPlaywrightMcp({
      ...base,
      resolveCommand: command => command === 'playwright-mcp' ? '/tools/playwright-mcp' : null,
    });
    expect(configured.status).toBe('configured');
    if (configured.status !== 'configured') return;
    expect(JSON.parse(readFileSync(configured.configPath, 'utf8')).browser.launchOptions).toMatchObject({
      channel: 'chrome',
      headless: true,
    });
    expect(JSON.parse(readFileSync(configured.configPath, 'utf8')).browser.launchOptions).not.toHaveProperty('executablePath');

    const otherWorkspace = prepareOwnerPlaywrightMcp({
      ...base,
      sessionId: 'session-4',
      resolveCommand: command => command === 'playwright-mcp' ? '/tools/playwright-mcp' : null,
    });
    expect(otherWorkspace.status).toBe('configured');
    if (otherWorkspace.status === 'configured') expect(otherWorkspace.profileDir).toBe(configured.profileDir);
  });

  it('passes Claude the canonical config path used by bwrap', () => {
    const realDataDir = mkdtempSync(join(tmpdir(), 'botmux-owner-playwright-real-'));
    const linkParent = mkdtempSync(join(tmpdir(), 'botmux-owner-playwright-link-'));
    roots.push(linkParent, realDataDir);
    const linkedDataDir = join(linkParent, 'data');
    symlinkSync(realDataDir, linkedDataDir, 'dir');
    const plan = prepareOwnerPlaywrightMcp({
      sessionId: 'session-linked', dataDir: linkedDataDir,
      freshProcess: true, claudeFamily: true, ownerCredentialIsolation: true,
      mounts: [{
        id: 'playwright', kind: 'directory', ownerSubdir: 'browser', source: '/owner/alice/browser', target: '/home/test/pw',
      }],
      resolveCommand: command => command === 'playwright-mcp' ? '/tools/playwright-mcp' : null,
    });
    expect(plan.status).toBe('configured');
    if (plan.status !== 'configured') return;
    expect(plan.configPath.startsWith(realDataDir)).toBe(true);
    expect(JSON.parse(plan.claudeArgs[1]!).mcpServers.playwright.args).toEqual(['--config', plan.configPath]);
  });
});
