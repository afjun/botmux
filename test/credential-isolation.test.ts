import { describe, expect, it } from 'vitest';
import {
  CredentialOwnerRequiredError,
  credentialPrincipalCanDrive,
  freezeCredentialIsolation,
  ownerDir,
  ownerFromEmail,
  resolveCredentialBindMounts,
  resolvePendingCredentialBootstraps,
} from '../src/core/owner.js';
import { normalizeCredentialIsolationConfig } from '../src/core/credential-isolation-config.js';

function makeConfig() {
  return normalizeCredentialIsolationConfig({
    enabled: true,
    presets: { bytedcli: true, bytecloud: false, devflow: false, playwright: true },
  }, { homeDir: '/home/tester', checkFilesystem: false })!;
}

describe('credential owner identity', () => {
  it('uses a normalized email prefix as the owner directory key', () => {
    expect(ownerFromEmail('  Alice.Dev@Example.com ')).toBe('alice.dev');
    expect(ownerDir('/home/tester/.botmux/', 'alice.dev'))
      .toBe('/home/tester/.botmux/owners/alice.dev');
  });

  it.each(['missing-at', '@example.com', '../escape@example.com', 'a/b@example.com'])
    ('rejects an unsafe or invalid email prefix: %s', email => {
      expect(ownerFromEmail(email)).toBeUndefined();
    });

  it('rejects an unsafe owner id loaded from persisted session state', () => {
    expect(() => ownerDir('/home/tester/.botmux', '../escape'))
      .toThrow(CredentialOwnerRequiredError);
  });

  it('requires both verified Open ID and email when isolation is enabled', () => {
    const config = makeConfig();
    expect(() => freezeCredentialIsolation(config, { openId: 'ou_alice' }))
      .toThrow(CredentialOwnerRequiredError);
    expect(() => freezeCredentialIsolation(config, { email: 'alice@example.com' }))
      .toThrow(CredentialOwnerRequiredError);
  });

  it('does not require an owner when isolation is disabled', () => {
    const config = makeConfig();
    expect(freezeCredentialIsolation({ ...config, enabled: false }, undefined)).toEqual({});
  });
});

describe('frozen credential isolation session state', () => {
  it('freezes the effective mount list and forces the file sandbox', () => {
    const config = makeConfig();
    const frozen = freezeCredentialIsolation(config, {
      openId: 'ou_alice',
      email: 'alice@example.com',
    });
    expect(frozen).toMatchObject({
      sandbox: true,
      credentialPrincipal: { ownerId: 'alice', openId: 'ou_alice' },
      credentialIsolation: { version: 1 },
    });
    expect(frozen.credentialIsolation?.mounts.map(mount => mount.id))
      .toEqual(['bytedcli', 'playwright']);

    config.mounts[0]!.ownerSubdir = 'mutated-live-config';
    expect(frozen.credentialIsolation?.mounts[0]?.ownerSubdir).toBe('bytedcli');
  });

  it('resolves cross-bot reusable owner sources to concrete tool targets', () => {
    const config = makeConfig();
    const frozen = freezeCredentialIsolation(config, {
      openId: 'ou_alice',
      email: 'alice@example.com',
    });
    const mounts = resolveCredentialBindMounts(frozen, '/home/tester', '/home/tester/.botmux');
    expect(mounts[0]).toMatchObject({
      source: '/home/tester/.botmux/owners/alice/bytedcli',
      target: '/home/tester/.local/share/bytedcli',
      kind: 'directory',
    });
  });

  it('allows only the credential principal to drive an isolated session', () => {
    const session = { credentialPrincipal: { ownerId: 'alice', openId: 'ou_alice' } };
    expect(credentialPrincipalCanDrive(session, 'ou_alice')).toBe(true);
    expect(credentialPrincipalCanDrive(session, 'ou_bob')).toBe(false);
    expect(credentialPrincipalCanDrive(session, undefined)).toBe(false);
    expect(credentialPrincipalCanDrive({}, 'ou_bob')).toBe(true);
  });

  it('maps owner-root success paths to the mounted tool paths', () => {
    const isolated = normalizeCredentialIsolationConfig({
      enabled: true,
      presets: { bytedcli: true, bytecloud: false, devflow: false, playwright: false },
    }, { homeDir: '/home/tester', checkFilesystem: false })!;
    const frozen = freezeCredentialIsolation(isolated, {
      openId: 'ou_alice', email: 'alice@example.com',
    });
    const mounts = resolveCredentialBindMounts(frozen, '/home/tester', '/home/tester/.botmux');
    const plans = resolvePendingCredentialBootstraps(
      mounts,
      '/home/tester/.botmux',
      'alice',
      command => `/usr/bin/${command}`,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: 'bytedcli',
      command: '/usr/bin/bytedcli',
      successPaths: ['/home/tester/.local/share/bytedcli/data/userinfo.json'],
      lockPath: '/home/tester/.local/share/bytedcli/.botmux-bootstrap-bytedcli.lock',
    });
  });
});
