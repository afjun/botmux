import { createHmac, randomUUID } from 'node:crypto';
import type { CardActionData } from '../im/lark/card-handler.js';

export function buildAgentTeamCallback(
  data: CardActionData,
  appId: string,
  env: NodeJS.ProcessEnv = process.env,
  timestamp = Math.floor(Date.now() / 1000).toString(),
  nonce = randomUUID(),
): { url: string; body: string; headers: Record<string, string> } {
  const serviceId = env.AGENT_TEAM_SERVICE_ID?.trim();
  const secret = env.AGENT_TEAM_SERVICE_SECRET;
  const tenantId = env.AGENT_TEAM_LARK_TENANT_ID?.trim();
  const url = new URL(env.AGENT_TEAM_CALLBACK_URL?.trim() ?? '');
  const localHTTP = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if ((!localHTTP && url.protocol !== 'https:') || !serviceId || !secret || !tenantId
    || !data.operator?.open_id || !data.action?.value) {
    throw new Error('Agent Team approval callback is not configured');
  }
  const body = JSON.stringify({
    operator: { open_id: data.operator.open_id },
    action: { value: data.action.value, form_value: data.action.form_value ?? {} },
  });
  const signedBody = `${tenantId}\n${appId}\n${body}`;
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${signedBody}`)
    .digest('hex');
  return {
    url: url.toString(), body,
    headers: {
      'content-type': 'application/json',
      'x-agent-team-service': serviceId,
      'x-agent-team-timestamp': timestamp,
      'x-agent-team-nonce': nonce,
      'x-agent-team-signature': signature,
      'x-lark-tenant-id': tenantId,
      'x-lark-app-id': appId,
    },
  };
}
