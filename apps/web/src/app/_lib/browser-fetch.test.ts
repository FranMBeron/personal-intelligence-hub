import { afterEach, describe, expect, it, vi } from "vitest";

import { DelegationClient } from "../agents/_lib/delegation-client";
import { ConversationClient } from "../_components/conversation/conversation-client";

/** Browsers reject `fetch` called with a receiver other than the global object ("Illegal invocation"). */
const strictFetch = vi.fn(function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
  if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
  return Promise.resolve(Response.json({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } }));
});

afterEach(() => { vi.unstubAllGlobals(); strictFetch.mockClear(); });

describe("default browser fetch", () => {
  it("is invoked unbound by the conversation client", async () => {
    vi.stubGlobal("fetch", strictFetch);
    await expect(new ConversationClient().listConversations({ agentId: "agent", archived: false, limit: 1 })).resolves.toMatchObject({ items: [] });
  });

  it("is invoked unbound by the delegation client", async () => {
    vi.stubGlobal("fetch", strictFetch);
    await expect(new DelegationClient().list({ sourceAgentId: "agent" })).resolves.toMatchObject({ items: [] });
  });
});
