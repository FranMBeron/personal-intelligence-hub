import { z } from "zod";

import type { ConnectorsDelegationClient } from "../delegation-client.js";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

/** Optional per-call context a Hermes tool runtime may pass to `execute`. */
export type CentralDelegationCallContext = Readonly<{ toolCallId?: string; sessionId?: string }>;

/**
 * Central-only delegation tool. Register it exclusively in the Central
 * (orchestrator) profile's gateway; never in a specialist's tool set, and never
 * through `createHermesTools`, which deliberately omits it. The peer tokens its
 * client holds belong only in Central's environment.
 *
 * The agent supplies only a target ID and a message; no origin, method, path,
 * command, or credential can be supplied. The source session comes from the
 * call context when the runtime provides it, otherwise from `HERMES_SESSION_ID`,
 * which is read on every call (never cached), so a long-lived gateway process
 * always forwards the session of the current call. The idempotency key is
 * deterministic (see `delegationIdempotencyKey`), so a retried call dedupes.
 */
export const createCentralDelegationTool = (client: ConnectorsDelegationClient) => {
  const inputSchema = z.object({
    targetAgentId: z.string().min(1).max(64),
    message: z.string().min(1).max(20_000),
  }).strict();
  return {
    inputSchema,
    execute: (input: { targetAgentId: string; message: string }, context: CentralDelegationCallContext = {}) => {
      const parsed = inputSchema.parse(input);
      const sessionId = context.sessionId !== undefined && SESSION_ID.test(context.sessionId) ? context.sessionId : process.env.HERMES_SESSION_ID;
      return client.start({
        ...parsed,
        ...(sessionId === undefined || !SESSION_ID.test(sessionId) ? {} : { sourceSessionId: sessionId }),
      }, context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId });
    },
  };
};
