import type { CalendarChangeProposal, Conversation, Delegation } from "@personal-intelligence-hub/contracts";
import { selectionFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { vi } from "vitest";

export type BffCall = Readonly<{ path: string; method: string; body: string | null }>;

const emptyPage = { hasNextPage: false, nextCursor: null };

/**
 * Fictional browser-side BFF used by page tests. It answers only reads by default and records every
 * request, so a test can prove that rendering a page performs no mutation.
 */
export const createBffFake = ({
  conversations = [],
  selections = {},
  delegations = [],
  proposals = [],
}: Readonly<{
  conversations?: readonly Conversation[];
  selections?: Readonly<Record<string, string | null>>;
  delegations?: readonly Delegation[];
  proposals?: readonly CalendarChangeProposal[];
}> = {}) => {
  const calls: BffCall[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://pih.example.test");
    const path = url.pathname;
    const method = init?.method ?? "GET";
    calls.push({ path: `${path}${url.search}`, method, body: typeof init?.body === "string" ? init.body : null });
    const selection = path.match(/^\/api\/ui\/v1\/agents\/([^/]+)\/conversation-selection$/u);
    if (selection !== null && method === "PUT") {
      // An explicit user choice; the recorded call lets tests prove which agent's selection changed.
      const agentId = decodeURIComponent(selection[1]!);
      const body = JSON.parse(String(init?.body)) as { conversationId: string; expectedVersion: number };
      return Response.json(selectionFixture({ agentId, conversationId: body.conversationId, version: body.expectedVersion + 1 }));
    }
    if (method !== "GET") return Response.json({ code: "unexpected_mutation" }, { status: 418 });
    if (selection !== null) {
      const agentId = decodeURIComponent(selection[1]!);
      return Response.json(selectionFixture({ agentId, conversationId: selections[agentId] ?? null, version: 1 }));
    }
    if (path === "/api/ui/v1/conversations") {
      const agentId = url.searchParams.get("agentId");
      const archived = url.searchParams.get("archived") === "true";
      const items = conversations.filter((item) => item.agentId === agentId && item.archived === archived);
      return Response.json({ items, pageInfo: emptyPage });
    }
    const history = path.match(/^\/api\/ui\/v1\/conversations\/([^/]+)\/messages$/u);
    if (history !== null) return Response.json({ items: [], pageInfo: emptyPage, streamCursor: "0" });
    const conversation = path.match(/^\/api\/ui\/v1\/conversations\/([^/]+)$/u);
    if (conversation !== null) {
      const found = conversations.find((item) => item.id === decodeURIComponent(conversation[1]!));
      return found === undefined ? Response.json({ code: "not_found" }, { status: 404 }) : Response.json(found);
    }
    if (path === "/api/ui/v1/delegations") {
      const source = url.searchParams.get("sourceAgentId");
      const target = url.searchParams.get("targetAgentId");
      const items = delegations.filter((item) => (source === null || item.sourceAgentId === source) && (target === null || item.targetAgentId === target));
      return Response.json({ items, pageInfo: emptyPage });
    }
    const delegation = path.match(/^\/api\/ui\/v1\/delegations\/([^/]+)$/u);
    if (delegation !== null) {
      const found = delegations.find((item) => item.id === decodeURIComponent(delegation[1]!));
      return found === undefined ? Response.json({ code: "not_found" }, { status: 404 }) : Response.json(found);
    }
    const proposal = path.match(/^\/api\/ui\/v1\/calendar\/change-proposals\/([^/]+)$/u);
    if (proposal !== null) {
      const found = proposals.find((item) => item.id === decodeURIComponent(proposal[1]!));
      return found === undefined ? Response.json({ code: "not_found" }, { status: 404 }) : Response.json(found);
    }
    // Event streams and anything unknown: an honest failure, never an invented success.
    return Response.json({ code: "dependency_unavailable" }, { status: 503 });
  });
  return {
    fetcher,
    calls,
    mutations: () => calls.filter((call) => call.method !== "GET"),
  };
};
