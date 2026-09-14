/**
 * Session-scoped relay authorization for Workflow v3 daemon mutations.
 *
 * A sandboxed (Linux bwrap) or read-isolated (macOS) chat CLI cannot use the
 * host mutation path: the process-tree markers, the run directory, and the
 * host `.dashboard-secret` are all masked by design, so
 * `authorizeV3DaemonCommand` + `postWorkflowDaemonMutation` fail before any
 * request leaves the sandbox. Instead of carving the global secret into the
 * sandbox (which would collapse the isolation boundary), the CLI presents its
 * per-turn rotating capability — the same aperture `/api/asks` already uses —
 * and this host-side module re-derives EVERY identity field from the daemon's
 * own live session record. The caller chooses nothing but the target runId
 * and the mutation payload; session/chat/caller identity is bound server-side.
 */

import { join } from 'node:path';
import { authorizeSessionScopedIpc } from '../../core/daemon-ipc-session-auth.js';
import {
  parseWorkflowDaemonMutationBody,
} from './daemon-ipc-body.js';
import type { WorkflowDaemonMutation } from './daemon-ipc-client.js';
import {
  WORKFLOW_PARAM_NAME_PATTERN,
  type RawParamInput,
} from '../shared/params.js';
import type { RunChatBinding } from './grill-state.js';
import type { SavedWorkflowActorContext } from './library-service.js';
import {
  authorizeV3RunMutationForCurrentTuple,
  V3DaemonCommandAuthorityError,
} from './cli-daemon-command-authority.js';
import { isValidRunId } from './ops-projection.js';

export const V3_SESSION_RUN_MUTATION_ROUTE_PREFIX = '/api/v3/session-runs';
export const V3_SESSION_RUN_CREATE_ROUTE = V3_SESSION_RUN_MUTATION_ROUTE_PREFIX;
export const V3_SESSION_SAVED_WORKFLOW_RUN_ROUTE =
  `${V3_SESSION_RUN_MUTATION_ROUTE_PREFIX}/saved-workflow`;
export const V3_SESSION_SPEC_FINALIZE_MUTATION = 'spec-finalize';

export function v3SessionWorkflowStagingDir(dataDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
    throw new Error(`invalid workflow staging session id: ${sessionId}`);
  }
  return join(dataDir, 'sandboxes', sessionId, 'workflow-runs');
}

export function v3SessionWorkflowSpecPath(
  dataDir: string,
  sessionId: string,
  runId: string,
): string {
  if (!isValidRunId(runId)) throw new Error(`invalid workflow staging run id: ${runId}`);
  return join(v3SessionWorkflowStagingDir(dataDir, sessionId), runId, 'spec.md');
}

export const V3_SESSION_RUN_MUTATIONS = ['start', 'cancel', 'retry', 'grant'] as const;

export function isV3SessionRunMutation(value: string): value is WorkflowDaemonMutation {
  return (V3_SESSION_RUN_MUTATIONS as readonly string[]).includes(value);
}

/** Live view of the claimed session, provided by the daemon's own registry. */
export interface V3SessionRelaySessionView {
  receiver: boolean;
  liveOrigin?: { capability: string; turnId?: string; dispatchAttempt?: number };
  callerOpenId?: string;
  chatId?: string;
  larkAppId?: string;
  chatType?: 'group' | 'p2p';
  rootMessageId?: string;
  /** The session's CURRENT inbound turn pointer — advances the moment the next
   * message arrives, while liveOrigin only rotates when that message is
   * actually dequeued into the CLI. The generation join below compares them. */
  quoteTargetId?: string;
  /** Chat-scope fold-back turn pointer (currentReplyTarget.turnId), advanced
   * together with quoteTargetId. */
  currentReplyTargetTurnId?: string;
}

export type V3SessionRelayDecision =
  | {
      ok: true;
      body: Record<string, unknown>;
      runDir: string;
      /** Owning bot from the run binding (== the daemon's own app id). */
      larkAppId: string;
    }
  | { ok: false; status: number; error: string; detail?: string };

export type V3SessionRunCreateDecision =
  | {
      ok: true;
      goal: string;
      chatBinding: RunChatBinding;
    }
  | { ok: false; status: number; error: string; detail?: string };

export type V3SessionSavedWorkflowRunDecision =
  | {
      ok: true;
      ref: string;
      rawParams: Record<string, RawParamInput>;
      context: SavedWorkflowActorContext;
    }
  | { ok: false; status: number; error: string; detail?: string };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type CurrentTurnDecision =
  | {
      ok: true;
      body: Record<string, unknown>;
      sessionId: string;
      current: V3SessionRelaySessionView & {
        callerOpenId: string;
        chatId: string;
        larkAppId: string;
      };
    }
  | { ok: false; status: number; error: string; detail?: string };

function authorizeCurrentTurn(input: {
  raw: unknown;
  trustedHost: boolean;
  session: V3SessionRelaySessionView | undefined;
  selfLarkAppId: string | undefined;
}): CurrentTurnDecision {
  if (!nonEmpty(input.selfLarkAppId)) {
    return { ok: false, status: 503, error: 'workflow_ipc_identity_unavailable' };
  }
  const body = input.raw && typeof input.raw === 'object' && !Array.isArray(input.raw)
    ? input.raw as Record<string, unknown>
    : undefined;
  if (!body) return { ok: false, status: 400, error: 'bad_json' };
  const sessionId = body.sessionId;
  if (!nonEmpty(sessionId)) return { ok: false, status: 400, error: 'missing_session_id' };

  const claimedAttempt = typeof body.originDispatchAttempt === 'number'
    && Number.isSafeInteger(body.originDispatchAttempt)
    && body.originDispatchAttempt > 0
    ? body.originDispatchAttempt
    : undefined;
  const verified = authorizeSessionScopedIpc({
    trustedHost: input.trustedHost,
    sessionExists: !!input.session,
    receiverSession: !!input.session?.receiver,
    allowReceiver: false,
    sessionId,
    ...(input.session?.liveOrigin ? { liveOrigin: input.session.liveOrigin } : {}),
    ...(typeof body.originCapability === 'string'
      ? { claimedCapability: body.originCapability }
      : {}),
    ...(typeof body.originTurnId === 'string' ? { claimedTurnId: body.originTurnId } : {}),
    ...(claimedAttempt !== undefined ? { claimedDispatchAttempt: claimedAttempt } : {}),
  });
  if (!verified.ok) return { ok: false, status: 403, error: verified.error };
  if (input.session?.receiver) {
    return { ok: false, status: 403, error: 'managed_action_required' };
  }

  const current = input.session;
  if (!current
    || !nonEmpty(current.callerOpenId)
    || !nonEmpty(current.chatId)
    || !nonEmpty(current.larkAppId)
    || current.larkAppId !== input.selfLarkAppId) {
    return { ok: false, status: 403, error: 'session_identity_incomplete' };
  }

  const liveTurnId = current.liveOrigin?.turnId;
  const quoteTargetId = current.quoteTargetId;
  const replyTurnId = current.currentReplyTargetTurnId;
  if (!nonEmpty(liveTurnId)
    || !nonEmpty(quoteTargetId)
    || quoteTargetId !== liveTurnId
    || (replyTurnId !== undefined && replyTurnId !== liveTurnId)) {
    return { ok: false, status: 403, error: 'turn_provenance_stale' };
  }

  return {
    ok: true,
    body,
    sessionId,
    current: {
      ...current,
      callerOpenId: current.callerOpenId,
      chatId: current.chatId,
      larkAppId: current.larkAppId,
    },
  };
}

export function authorizeV3SessionRunCreateRequest(input: {
  raw: unknown;
  trustedHost: boolean;
  session: V3SessionRelaySessionView | undefined;
  selfLarkAppId: string | undefined;
}): V3SessionRunCreateDecision {
  const authorized = authorizeCurrentTurn(input);
  if (!authorized.ok) return authorized;
  if (!nonEmpty(authorized.body.goal)) {
    return { ok: false, status: 400, error: 'missing_goal' };
  }
  const current = authorized.current;
  return {
    ok: true,
    goal: authorized.body.goal,
    chatBinding: {
      larkAppId: current.larkAppId,
      chatId: current.chatId,
      sessionId: authorized.sessionId,
      ownerOpenId: current.callerOpenId,
      ...(current.chatType ? { chatType: current.chatType } : {}),
      ...(nonEmpty(current.rootMessageId) ? { rootMessageId: current.rootMessageId } : {}),
    },
  };
}

const FORBIDDEN_PARAM_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

export function authorizeV3SessionSavedWorkflowRunRequest(input: {
  raw: unknown;
  trustedHost: boolean;
  session: V3SessionRelaySessionView | undefined;
  selfLarkAppId: string | undefined;
}): V3SessionSavedWorkflowRunDecision {
  const authorized = authorizeCurrentTurn(input);
  if (!authorized.ok) return authorized;
  const ref = authorized.body.ref;
  if (!nonEmpty(ref)) {
    return { ok: false, status: 400, error: 'missing_workflow_ref' };
  }
  const raw = authorized.body.rawParams;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'bad_workflow_params' };
  }
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, status: 400, error: 'bad_workflow_params' };
  }
  const rawParams = Object.create(null) as Record<string, RawParamInput>;
  for (const [name, candidate] of Object.entries(raw)) {
    if (!WORKFLOW_PARAM_NAME_PATTERN.test(name) || FORBIDDEN_PARAM_NAMES.has(name)
      || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { ok: false, status: 400, error: 'bad_workflow_params' };
    }
    const value = candidate as Record<string, unknown>;
    if (value.kind === 'string' && typeof value.value === 'string') {
      rawParams[name] = { kind: 'string', value: value.value };
    } else if (value.kind === 'json' && Object.prototype.hasOwnProperty.call(value, 'value')) {
      rawParams[name] = { kind: 'json', value: value.value };
    } else {
      return { ok: false, status: 400, error: 'bad_workflow_params' };
    }
  }
  const current = authorized.current;
  return {
    ok: true,
    ref,
    rawParams,
    context: {
      actor: { larkAppId: current.larkAppId, openId: current.callerOpenId },
      chatId: current.chatId,
      ...(current.chatType ? { chatType: current.chatType } : {}),
      ...(nonEmpty(current.rootMessageId) ? { rootMessageId: current.rootMessageId } : {}),
      sessionId: authorized.sessionId,
    },
  };
}

/** Mutation payload keys the relay forwards; everything else is dropped so a
 * sandboxed caller cannot smuggle fields past the shared body parser. */
const MUTATION_BODY_KEYS: Record<WorkflowDaemonMutation, readonly string[]> = {
  start: [],
  cancel: ['reason'],
  retry: ['nodeId'],
  grant: ['loopId'],
};

/**
 * Authorize one relayed mutation request. Deliberately pure: the daemon route
 * supplies the live session view and trusted-host flag, so the full
 * capability → session → run-binding chain is unit-testable without HTTP.
 */
export function authorizeV3SessionRunMutationRequest(input: {
  runId: string;
  mutation: string;
  /** Parsed JSON request body (untrusted). */
  raw: unknown;
  trustedHost: boolean;
  /** undefined when the claimed sessionId has no live session on this daemon. */
  session: V3SessionRelaySessionView | undefined;
  selfLarkAppId: string | undefined;
  baseDir: string;
}): V3SessionRelayDecision {
  if (!isV3SessionRunMutation(input.mutation)) {
    return { ok: false, status: 404, error: 'unknown_mutation' };
  }
  if (!isValidRunId(input.runId)) {
    return { ok: false, status: 400, error: 'bad_run_id' };
  }
  const authorized = authorizeCurrentTurn(input);
  if (!authorized.ok) return authorized;
  const { body, current } = authorized;

  let authority;
  try {
    authority = authorizeV3RunMutationForCurrentTuple({
      runId: input.runId,
      baseDir: input.baseDir,
      current: {
        callerOpenId: current.callerOpenId,
        chatId: current.chatId,
        larkAppId: current.larkAppId,
      },
    });
  } catch (err) {
    if (err instanceof V3DaemonCommandAuthorityError) {
      return { ok: false, status: 403, error: 'run_binding_mismatch', detail: err.message };
    }
    throw err;
  }
  if (authority.larkAppId !== input.selfLarkAppId) {
    return {
      ok: false,
      status: 409,
      error: 'wrong_daemon',
      detail: `run 归属 ${authority.larkAppId}`,
    };
  }

  // Re-validate the payload with the exact same parser the signed-envelope
  // route uses, from an allowlisted subset only.
  const subset: Record<string, unknown> = {};
  for (const key of MUTATION_BODY_KEYS[input.mutation]) {
    if (body[key] !== undefined) subset[key] = body[key];
  }
  const parsed = parseWorkflowDaemonMutationBody(input.mutation, JSON.stringify(subset));
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  return {
    ok: true,
    body: parsed.body.value as Record<string, unknown>,
    runDir: authority.runDir,
    larkAppId: authority.larkAppId,
  };
}
