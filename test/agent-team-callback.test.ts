import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAgentTeamCallback } from '../src/services/agent-team-callback.js';

describe('Agent Team approval callback', () => {
  it('signs the exact native callback body expected by the platform', () => {
    const callback = buildAgentTeamCallback({
      operator: { open_id: 'ou_owner' },
      action: { value: { action: 'agent_team_question_select', nonce: 'outbox-1' } },
    }, 'cli_orchestrator', {
      AGENT_TEAM_CALLBACK_URL: 'http://127.0.0.1:18092/api/v1/internal/lark/cards/native-callback',
      AGENT_TEAM_SERVICE_ID: 'local-test', AGENT_TEAM_SERVICE_SECRET: 'secret',
      AGENT_TEAM_LARK_TENANT_ID: 'local-tenant',
    }, '1000', 'request-nonce');
    const expected = createHmac('sha256', 'secret')
      .update(`1000\nrequest-nonce\nlocal-tenant\ncli_orchestrator\n${callback.body}`)
      .digest('hex');
    expect(callback.headers['x-agent-team-signature']).toBe(expected);
    expect(JSON.parse(callback.body).operator.open_id).toBe('ou_owner');
  });
});
