import { describe, expect, it } from 'vitest';
import { normalizeCredentialOwner } from '../src/dashboard/connector-api.js';
import { extractCredentialOwnerCandidates } from '../src/dashboard/webhook-routes.js';

describe('normalizeCredentialOwner', () => {
  it('trims and accepts the configured absolute and candidate-relative paths', () => {
    expect(normalizeCredentialOwner({
      path: '  $.meego.owners ',
      openIdPath: ' $.open_id ',
      emailPath: ' email ',
    }, undefined)).toEqual({
      ok: true,
      value: {
        path: '$.meego.owners',
        openIdPath: '$.open_id',
        emailPath: 'email',
      },
    });
  });

  it('preserves an existing extractor when an update omits the field', () => {
    const prior = { path: '$.owners', openIdPath: '$.open_id', emailPath: '$.email' };
    expect(normalizeCredentialOwner(undefined, prior)).toEqual({ ok: true, value: prior });
    expect(normalizeCredentialOwner(null, prior)).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['missing a required field', { path: '$.owners', openIdPath: '$.open_id' }],
    ['using an array index syntax', { path: '$.owners[0]', openIdPath: '$.open_id', emailPath: '$.email' }],
    ['using a relative collection path', { path: 'owners', openIdPath: '$.open_id', emailPath: '$.email' }],
    ['using a prototype segment', { path: '$.__proto__.owners', openIdPath: '$.open_id', emailPath: '$.email' }],
    ['including an unknown key', { path: '$.owners', openIdPath: '$.open_id', emailPath: '$.email', command: 'whoami' }],
    ['using a non-object', '$.owners'],
  ])('rejects an extractor %s', (_label, value) => {
    expect(normalizeCredentialOwner(value, undefined)).toEqual({
      ok: false,
      error: 'credential_owner_extractor_invalid',
    });
  });
});

describe('extractCredentialOwnerCandidates', () => {
  const extractor = {
    path: '$.meego.owners',
    openIdPath: '$.identity.open_id',
    emailPath: '$.identity.email',
  };

  it('extracts candidates in payload order without treating payload email as authoritative', () => {
    const candidates = extractCredentialOwnerCandidates({
      meego: {
        owners: [
          { identity: { open_id: ' ou_first ', email: ' first@example.test ' } },
          { identity: { open_id: 'ou_second', email: 'second@example.test' } },
        ],
      },
    }, extractor);

    expect(candidates).toEqual([
      { openId: 'ou_first', email: 'first@example.test' },
      { openId: 'ou_second', email: 'second@example.test' },
    ]);
  });

  it('skips malformed candidates while retaining later valid candidates', () => {
    expect(extractCredentialOwnerCandidates({
      meego: {
        owners: [
          null,
          { identity: { open_id: 123, email: 'number@example.test' } },
          { identity: { open_id: 'not-an-open-id', email: 'bad@example.test' } },
          { identity: { open_id: 'ou_missing_email', email: 123 } },
          { identity: { open_id: 'ou_bad_email', email: 'not-an-email' } },
          { identity: { open_id: 'ou_valid', email: 'valid@example.test' } },
        ],
      },
    }, extractor)).toEqual([{ openId: 'ou_valid', email: 'valid@example.test' }]);
  });

  it('returns an empty list when the configured collection is absent or not an array', () => {
    expect(extractCredentialOwnerCandidates({}, extractor)).toEqual([]);
    expect(extractCredentialOwnerCandidates({ meego: { owners: {} } }, extractor)).toEqual([]);
    expect(extractCredentialOwnerCandidates({ meego: { owners: [] } }, undefined)).toEqual([]);
  });
});
