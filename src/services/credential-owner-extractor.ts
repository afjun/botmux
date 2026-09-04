import type { ConnectorCredentialOwnerExtractor } from './connector-store.js';
import { getJsonPathValue } from './webhook-lifecycle-extractors.js';

export interface WebhookCredentialOwnerCandidate {
  openId: string;
  email: string;
}

/** Extract ordered, untrusted owner candidates. Open IDs and emails must be
 * verified through the target Bot before becoming a Credential Principal. */
export function extractCredentialOwnerCandidates(
  payload: unknown,
  extractor: ConnectorCredentialOwnerExtractor | undefined,
): WebhookCredentialOwnerCandidate[] {
  if (!extractor) return [];
  const rawCandidates = getJsonPathValue(payload, extractor.path);
  if (!Array.isArray(rawCandidates)) return [];
  const candidates: WebhookCredentialOwnerCandidate[] = [];
  for (const rawCandidate of rawCandidates) {
    const rawOpenId = getJsonPathValue(rawCandidate, extractor.openIdPath);
    if (typeof rawOpenId !== 'string') continue;
    const openId = rawOpenId.trim();
    if (!/^ou_[A-Za-z0-9_-]+$/.test(openId)) continue;
    const rawEmail = getJsonPathValue(rawCandidate, extractor.emailPath);
    const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
    // The configured payload email is required so the target Bot can compare
    // it with the canonical contact profile before accepting this candidate.
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) continue;
    candidates.push({ openId, email });
  }
  return candidates;
}
