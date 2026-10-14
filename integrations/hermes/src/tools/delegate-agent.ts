import { z } from "zod";

import type { ConnectorsDelegationClient } from "../delegation-client.js";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;

/**
 * The only delegation surface an agent receives: a target ID and a message.
 * No origin, method, path, command, or credential can be supplied.
 */
export const createDelegateAgentTool = (client: ConnectorsDelegationClient) => {
  const inputSchema = z.object({
    targetAgentId: z.string().min(1).max(64),
    message: z.string().min(1).max(20_000),
  }).strict();
  return {
    inputSchema,
    execute: (input: { targetAgentId: string; message: string }) => {
      const parsed = inputSchema.parse(input);
      const sessionId = process.env.HERMES_SESSION_ID;
      return client.start({
        ...parsed,
        ...(sessionId === undefined || !SESSION_ID.test(sessionId) ? {} : { sourceSessionId: sessionId }),
      });
    },
  };
};
