import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBotConfigsFromText } from '../src/bot-registry.js';
import {
  CREDENTIAL_BOOTSTRAP_DEFAULT_TIMEOUT_SECONDS,
  normalizeCredentialIsolationConfig,
} from '../src/core/credential-isolation-config.js';

const normalize = (raw: unknown, workingDirs: string[] = []) => normalizeCredentialIsolationConfig(raw, {
  homeDir: '/home/tester',
  workingDirs,
  checkFilesystem: false,
});

describe('normalizeCredentialIsolationConfig', () => {
  it('keeps a disabled policy inert even when dormant mounts are malformed', () => {
    expect(normalize({ enabled: false, mounts: 'not-active' })).toEqual({
      enabled: false,
      presets: { bytedcli: true, bytecloud: true, devflow: true, playwright: true },
      mounts: [],
    });
  });

  it('enables all core presets by default', () => {
    const config = normalize({ enabled: true })!;

    expect(config.presets).toEqual({
      bytedcli: true,
      bytecloud: true,
      devflow: true,
      playwright: true,
    });
    expect(config.mounts.map(mount => mount.id)).toEqual([
      'bytedcli',
      'bytecloud',
      'devflow-conf',
      'devflow-auth',
      'playwright',
    ]);
    expect(config.mounts.find(mount => mount.id === 'playwright')).toMatchObject({
      target: '~/.cache/ms-playwright-mcp',
      ownerSubdir: 'playwright',
      bootstrap: undefined,
    });
    expect(config.mounts.find(mount => mount.id === 'devflow-auth')?.target)
      .toBe('~/.devflow-cli/localcache');
    expect(config.mounts.find(mount => mount.id === 'devflow-auth')?.bootstrap?.successPaths)
      .toEqual(['devflow/localcache/cloud_jwt_token.txt']);
    expect(config.mounts.find(mount => mount.id === 'bytedcli')?.bootstrap?.successPaths)
      .toEqual(['bytedcli/data/userinfo.json']);
    expect(config.mounts.some(mount => mount.target === '~/.devflow-cli')).toBe(false);
  });

  it('supports disabling presets and mounts by id', () => {
    const config = normalize({
      enabled: true,
      presets: { bytecloud: false, playwright: false },
      mounts: [{ id: 'devflow-conf', enabled: false }],
    })!;

    expect(config.mounts.map(mount => mount.id)).toEqual(['bytedcli', 'devflow-auth']);
  });

  it('overrides a built-in mount by id and canonicalizes $HOME', () => {
    const config = normalize({
      enabled: true,
      mounts: [{
        id: 'bytedcli',
        target: '$HOME/.state/bytedcli',
        ownerSubdir: 'custom/bytedcli',
        bootstrap: null,
      }],
    })!;

    expect(config.mounts.find(mount => mount.id === 'bytedcli')).toEqual({
      id: 'bytedcli',
      kind: 'directory',
      target: '~/.state/bytedcli',
      ownerSubdir: 'custom/bytedcli',
      bootstrap: undefined,
    });
  });

  it('adds a structured custom directory mount and defaults bootstrap timeout', () => {
    const config = normalize({
      enabled: true,
      presets: { bytedcli: false, bytecloud: false, devflow: false, playwright: false },
      mounts: [{
        id: 'custom-token',
        kind: 'directory',
        target: '~/.config/example',
        ownerSubdir: 'example',
        bootstrap: {
          command: 'example-cli',
          args: ['login', '--device'],
          successPaths: ['example/token.json'],
          checkCommand: { command: 'example-cli', args: ['auth', 'status'] },
        },
      }],
    })!;

    expect(config.mounts).toEqual([{
      id: 'custom-token',
      kind: 'directory',
      target: '~/.config/example',
      ownerSubdir: 'example',
      bootstrap: {
        command: 'example-cli',
        args: ['login', '--device'],
        successPaths: ['example/token.json'],
        checkCommand: { command: 'example-cli', args: ['auth', 'status'] },
        timeoutSeconds: CREDENTIAL_BOOTSTRAP_DEFAULT_TIMEOUT_SECONDS,
      },
    }]);
  });

  it('allows file mounts but rejects bootstrap because the shared lock needs a directory mount', () => {
    const fileOnly = normalize({
      enabled: true,
      presets: { bytedcli: false, bytecloud: false, devflow: false, playwright: false },
      mounts: [{ id: 'token', kind: 'file', target: '~/.config/tool/token', ownerSubdir: 'tool/token' }],
    });
    expect(fileOnly?.mounts[0]?.kind).toBe('file');

    expect(() => normalize({
      enabled: true,
      presets: { bytedcli: false, bytecloud: false, devflow: false, playwright: false },
      mounts: [{
        id: 'token', kind: 'file', target: '~/.config/tool/token', ownerSubdir: 'tool/token',
        bootstrap: { command: 'tool', args: ['login'], successPaths: ['tool/token'] },
      }],
    })).toThrow('bootstrap: is supported only for directory mounts');
  });

  it.each([
    ['/etc/passwd', 'must start with'],
    ['~/', 'strictly below'],
    ['~/.botmux/owners', 'must not target ~/.botmux'],
    ['~/projects', 'working directory'],
  ])('rejects unsafe target %s', (target, expected) => {
    expect(() => normalize({
      enabled: true,
      presets: { bytedcli: false, bytecloud: false, devflow: false, playwright: false },
      mounts: [{
        id: 'unsafe',
        kind: 'directory',
        target,
        ownerSubdir: 'unsafe',
      }],
    }, ['/home/tester/projects/repo'])).toThrow(expected);
  });

  it.each(['../escape', '/absolute', 'nested/../escape', 'nested\\escape'])
    ('rejects unsafe ownerSubdir %s', ownerSubdir => {
      expect(() => normalize({
        enabled: true,
        presets: { bytedcli: false, bytecloud: false, devflow: false, playwright: false },
        mounts: [{
          id: 'unsafe',
          kind: 'directory',
          target: '~/.config/example',
          ownerSubdir,
        }],
      })).toThrow('ownerSubdir');
    });

  it.each([29, 1801, 30.5, '600'])('rejects bootstrap timeout %s', timeoutSeconds => {
    expect(() => normalize({
      enabled: true,
      presets: { bytedcli: false, bytecloud: false, devflow: false, playwright: false },
      mounts: [{
        id: 'custom',
        kind: 'directory',
        target: '~/.config/custom',
        ownerSubdir: 'custom',
        bootstrap: {
          command: 'custom',
          successPaths: ['ready'],
          timeoutSeconds,
        },
      }],
    })).toThrow('timeoutSeconds');
  });

  it('rejects a target that escapes HOME through an existing symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-credential-config-'));
    const homeDir = join(root, 'home');
    const outside = join(root, 'outside');
    mkdirSync(homeDir);
    mkdirSync(outside);
    symlinkSync(outside, join(homeDir, '.escaped'));
    try {
      expect(() => normalizeCredentialIsolationConfig({
        enabled: true,
        presets: { bytedcli: false, bytecloud: false, devflow: false, playwright: false },
        mounts: [{
          id: 'escaped',
          kind: 'directory',
          target: '~/.escaped/credentials',
          ownerSubdir: 'escaped',
        }],
      }, { homeDir })).toThrow('symbolic link');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects duplicate ids, targets and owner subdirectories', () => {
    const base = {
      enabled: true,
      presets: { bytedcli: false, bytecloud: false, devflow: false, playwright: false },
    };
    expect(() => normalize({ ...base, mounts: [
      { id: 'same', kind: 'directory', target: '~/.a', ownerSubdir: 'a' },
      { id: 'same', kind: 'directory', target: '~/.b', ownerSubdir: 'b' },
    ] })).toThrow('must be unique');
    expect(() => normalize({ ...base, mounts: [
      { id: 'a', kind: 'directory', target: '~/.same', ownerSubdir: 'a' },
      { id: 'b', kind: 'directory', target: '~/.same', ownerSubdir: 'b' },
    ] })).toThrow('overlapping mount targets');
    expect(() => normalize({ ...base, mounts: [
      { id: 'a', kind: 'directory', target: '~/.a', ownerSubdir: 'same' },
      { id: 'b', kind: 'directory', target: '~/.b', ownerSubdir: 'same' },
    ] })).toThrow('overlapping ownerSubdir');
    expect(() => normalize({ ...base, mounts: [
      { id: 'a', kind: 'directory', target: '~/.config', ownerSubdir: 'a' },
      { id: 'b', kind: 'directory', target: '~/.config/tool', ownerSubdir: 'b' },
    ] })).toThrow('overlapping mount targets');
    expect(() => normalize({ ...base, mounts: [
      { id: 'a', kind: 'directory', target: '~/.a', ownerSubdir: 'tools' },
      { id: 'b', kind: 'directory', target: '~/.b', ownerSubdir: 'tools/cache' },
    ] })).toThrow('overlapping ownerSubdir');
  });
});

describe('parseBotConfigsFromText credential isolation', () => {
  const base = { larkAppId: 'cli_test', larkAppSecret: 'test-secret' };

  it('returns a session-ready normalized snapshot', () => {
    const [bot] = parseBotConfigsFromText(JSON.stringify([{
      ...base,
      credentialIsolation: {
        enabled: true,
        presets: { bytecloud: false },
        mounts: [{ id: 'playwright', enabled: false }],
      },
    }]));

    expect(bot.credentialIsolation?.enabled).toBe(true);
    expect(bot.credentialIsolation?.mounts.map(mount => mount.id)).toEqual([
      'bytedcli',
      'devflow-conf',
      'devflow-auth',
    ]);
  });

  it('fails closed on malformed enabled config instead of dropping entries', () => {
    expect(() => parseBotConfigsFromText(JSON.stringify([{
      ...base,
      credentialIsolation: { enabled: true, mounts: { '~/.legacy': 'legacy' } },
    }]))).toThrow('mounts: must be an array');
  });
});
