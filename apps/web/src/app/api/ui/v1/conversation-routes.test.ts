// @vitest-environment node

import { conversationFixture, delegationFixture, selectionFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { describe, expect, it, vi } from "vitest";

import type { RequestIdentityAdapter } from "../../../../server/context";
import { IdentityConcurrencyLimiter } from "../../../../server/identity-concurrency";
import { IdentityRateLimiter } from "../../../../server/identity-rate-limit";
import { GatewayError } from "../../../../server/problems";
import type { HermesGateway } from "../../../../server/ports/hermes-gateway";
import {
  createGetConversationHandler,
  createGetMessageHistoryHandler,
  createGetConversationSelectionHandler,
  createListConversationsHandler,
  createListDelegationsHandler,
  createGetDelegationHandler,
  createResolveMainConversationHandler,
  createSelectConversationHandler,
  createUpdateConversationHandler,
} from "./_lib/conversation-handlers";
import type { RequestPolicy } from "./_lib/request-guards";

const principal = { actorId: "a03f7492-09f0-4e8f-95d0-12b7c616aaea", subject: "user:fictional@example.test", actorType: "human" as const };
const identity: RequestIdentityAdapter = {
  async resolve(headers) {
    const authorization = headers.get("authorization");
    if (authorization === null || !/^Bearer\s+\S+$/iu.test(authorization)) {
      return { ok: false, status: 401, title: "Authentication required", detail: "A bearer token is required." };
    }
    return { ok: true, authorization, concurrencyKey: "oidc:fictional-human", principal };
  },
};
const policy: RequestPolicy = {
  publicOrigin: "https://pih.example",
  identity,
  maxUploadBodyBytes: 1_048_576,
  agentConcurrency: new IdentityConcurrencyLimiter(2),
  agentRateLimit: new IdentityRateLimiter({ maximum: 20 }),
};
const headers = (values: HeadersInit = {}) => new Headers({
  authorization: "Bearer delegated-test-token",
  origin: "https://pih.example",
  "content-type": "application/json",
  ...values,
});
const jsonRequest = (path: string, method: string, value: unknown, values: HeadersInit = {}) =>
  new Request("https://pih.example/api/ui/v1" + path, { method, headers: headers(values), body: JSON.stringify(value) });
const params = <K extends string>(name: K, value: string): { params: Promise<Record<K, string>> } =>
  ({ params: Promise.resolve({ [name]: value } as Record<K, string>) });

const safeConflict = () => new GatewayError({
  type: "about:blank", title: "Version conflict", status: 409, detail: "Reload before retrying.",
  instance: "/api/ui/v1", code: "version_conflict", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
});

describe("conversation, selection and delegation route handlers", () => {
  it("requires authentication and returns a no-store validated conversation list", async () => {
    const listConversations = vi.fn(async () => ({ items: [conversationFixture()], pageInfo: { nextCursor: null, hasNextPage: false } }));
    const handler = createListConversationsHandler({ listConversations } as unknown as HermesGateway, policy);
    const unauthorized = await handler(new Request("https://pih.example/api/ui/v1/conversations"));
    expect(unauthorized.status).toBe(401);
    const response = await handler(new Request("https://pih.example/api/ui/v1/conversations?agentId=agent-1&limit=3", { headers: headers() }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(listConversations).toHaveBeenCalledWith(expect.objectContaining({ principal }), expect.objectContaining({ agentId: "agent-1", limit: 3 }), expect.any(AbortSignal));
    await expect(response.json()).resolves.toMatchObject({ items: [{ id: "fictional-conversation" }] });
  });

  it("rejects unsupported and repeated query fields before reading the list", async () => {
    const listConversations = vi.fn(async () => ({ items: [], pageInfo: { nextCursor: null, hasNextPage: false } }));
    const handler = createListConversationsHandler({ listConversations } as unknown as HermesGateway, policy);
    const unsupported = await handler(new Request("https://pih.example/api/ui/v1/conversations?private=1", { headers: headers() }));
    const repeated = await handler(new Request("https://pih.example/api/ui/v1/conversations?limit=2&limit=3", { headers: headers() }));
    expect(unsupported.status).toBe(422);
    expect(repeated.status).toBe(422);
    expect(listConversations).not.toHaveBeenCalled();
  });

  it("reads a conversation without creating a main conversation", async () => {
    const getConversation = vi.fn(async () => conversationFixture());
    const resolveMainConversation = vi.fn(async () => conversationFixture());
    const handler = createGetConversationHandler({ getConversation, resolveMainConversation } as unknown as HermesGateway, policy);
    const response = await handler(new Request("https://pih.example/api/ui/v1/conversations/fictional", { headers: headers() }), params("conversationId", "fictional"));
    expect(response.status).toBe(200);
    expect(getConversation).toHaveBeenCalledTimes(1);
    expect(resolveMainConversation).not.toHaveBeenCalled();
  });

  it("reads message history with a strict page query", async () => {
    const history = vi.fn(async () => ({
      items: [],
      pageInfo: { nextCursor: null, hasNextPage: false },
      streamCursor: "0",
    }));
    const handler = createGetMessageHistoryHandler({ history } as unknown as HermesGateway, policy);
    const response = await handler(
      new Request("https://pih.example/api/ui/v1/conversations/fictional/messages?limit=5", { headers: headers() }),
      params("conversationId", "fictional"),
    );
    expect(response.status).toBe(200);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ principal }), "fictional", { cursor: undefined, limit: 5 }, expect.any(AbortSignal));
    const invalid = await handler(
      new Request("https://pih.example/api/ui/v1/conversations/fictional/messages?unknown=1", { headers: headers() }),
      params("conversationId", "fictional"),
    );
    expect(invalid.status).toBe(422);
    expect(history).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "https://foreign.example"])("does not resolve the main conversation without the application origin (%s)", async (origin) => {
    const resolveMainConversation = vi.fn();
    const handler = createResolveMainConversationHandler({ resolveMainConversation } as unknown as HermesGateway, policy);
    const requestHeaders = origin === undefined
      ? { authorization: "Bearer delegated-test-token", origin: "" }
      : { authorization: "Bearer delegated-test-token", origin };
    const response = await handler(
      new Request("https://pih.example/api/ui/v1/agents/fictional/main-conversation", { method: "PUT", headers: requestHeaders }),
      params("agentId", "fictional"),
    );
    expect(response.status).toBe(403);
    expect(resolveMainConversation).not.toHaveBeenCalled();
  });

  it("reads the selected conversation without mutating selection", async () => {
    const getConversationSelection = vi.fn(async () => selectionFixture());
    const selectConversation = vi.fn();
    const handler = createGetConversationSelectionHandler({ getConversationSelection, selectConversation } as unknown as HermesGateway, policy);
    const response = await handler(
      new Request("https://pih.example/api/ui/v1/agents/fictional/conversation-selection", { headers: headers() }),
      params("agentId", "fictional"),
    );
    expect(response.status).toBe(200);
    expect(getConversationSelection).toHaveBeenCalledWith(expect.objectContaining({ principal }), "fictional", expect.any(AbortSignal));
    expect(selectConversation).not.toHaveBeenCalled();
  });

  it("preserves expectedVersion and a safe conflict on conversation updates", async () => {
    const updateConversation = vi.fn(async () => { throw safeConflict(); });
    const handler = createUpdateConversationHandler({ updateConversation } as unknown as HermesGateway, policy);
    const response = await handler(jsonRequest("/conversations/fictional", "PATCH", { title: "Renamed", expectedVersion: 7 }), params("conversationId", "fictional"));
    expect(response.status).toBe(409);
    expect(updateConversation).toHaveBeenCalledWith(expect.objectContaining({ principal }), "fictional", { title: "Renamed", expectedVersion: 7 }, expect.any(AbortSignal));
    await expect(response.json()).resolves.toMatchObject({ code: "version_conflict", status: 409 });
  });

  it.each([undefined, "https://foreign.example"])("does not update a conversation without the application origin (%s)", async (origin) => {
    const updateConversation = vi.fn();
    const handler = createUpdateConversationHandler({ updateConversation } as unknown as HermesGateway, policy);
    const requestHeaders = origin === undefined
      ? { authorization: "Bearer delegated-test-token", origin: "" }
      : { authorization: "Bearer delegated-test-token", origin };
    const response = await handler(
      jsonRequest("/conversations/fictional", "PATCH", { title: "Renamed", expectedVersion: 1 }, requestHeaders),
      params("conversationId", "fictional"),
    );
    expect(response.status).toBe(403);
    expect(updateConversation).not.toHaveBeenCalled();
  });

  it("rejects malformed conversation bodies and unsupported query before gateway calls", async () => {
    const updateConversation = vi.fn();
    const handler = createUpdateConversationHandler({ updateConversation } as unknown as HermesGateway, policy);
    const malformed = await handler(jsonRequest("/conversations/fictional", "PATCH", { title: "", expectedVersion: 0 }), params("conversationId", "fictional"));
    expect(malformed.status).toBe(422);
    expect(updateConversation).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://foreign.example"])("does not select a conversation without the application origin (%s)", async (origin) => {
    const selectConversation = vi.fn(async () => selectionFixture());
    const handler = createSelectConversationHandler({ selectConversation } as unknown as HermesGateway, policy);
    const requestHeaders = origin === undefined
      ? { authorization: "Bearer delegated-test-token", origin: "" }
      : { authorization: "Bearer delegated-test-token", origin };
    const response = await handler(jsonRequest("/agents/agent-1/conversation-selection", "PUT", { conversationId: "conversation-1", expectedVersion: 0 }, requestHeaders), params("agentId", "agent-1"));
    expect(response.status).toBe(403);
    expect(selectConversation).not.toHaveBeenCalled();
  });

  it("forwards the selection version unchanged and returns safe conflicts", async () => {
    const selectConversation = vi.fn(async () => { throw safeConflict(); });
    const handler = createSelectConversationHandler({ selectConversation } as unknown as HermesGateway, policy);
    const response = await handler(jsonRequest("/agents/agent-1/conversation-selection", "PUT", { conversationId: "conversation-1", expectedVersion: 12 }), params("agentId", "agent-1"));
    expect(response.status).toBe(409);
    expect(selectConversation).toHaveBeenCalledWith(expect.objectContaining({ principal }), "agent-1", { conversationId: "conversation-1", expectedVersion: 12 }, expect.any(AbortSignal));
  });

  it("resolves the main conversation only after an explicit authenticated PUT", async () => {
    const resolveMainConversation = vi.fn(async () => conversationFixture());
    const handler = createResolveMainConversationHandler({ resolveMainConversation } as unknown as HermesGateway, policy);
    const response = await handler(new Request("https://pih.example/api/ui/v1/agents/agent-1/main-conversation", { method: "PUT", headers: headers() }), params("agentId", "agent-1"));
    expect(response.status).toBe(200);
    expect(resolveMainConversation).toHaveBeenCalledTimes(1);
  });

  it("lists and reads delegations with strict query validation", async () => {
    const listDelegations = vi.fn(async () => ({ items: [delegationFixture()], pageInfo: { nextCursor: null, hasNextPage: false } }));
    const getDelegation = vi.fn(async () => delegationFixture());
    const listHandler = createListDelegationsHandler({ listDelegations } as unknown as HermesGateway, policy);
    const getHandler = createGetDelegationHandler({ getDelegation } as unknown as HermesGateway, policy);
    const list = await listHandler(new Request("https://pih.example/api/ui/v1/delegations?sourceAgentId=agent-1&state=queued", { headers: headers() }));
    expect(list.status).toBe(200);
    const invalid = await listHandler(new Request("https://pih.example/api/ui/v1/delegations?private=payload", { headers: headers() }));
    expect(invalid.status).toBe(422);
    const detail = await getHandler(new Request("https://pih.example/api/ui/v1/delegations/fictional", { headers: headers() }), params("delegationId", "fictional"));
    expect(detail.status).toBe(200);
    expect(getDelegation).toHaveBeenCalledWith(expect.objectContaining({ principal }), "fictional", expect.any(AbortSignal));
  });

  it("preserves a safe downstream authorization denial", async () => {
    const forbidden = new GatewayError({
      type: "about:blank", title: "Forbidden", status: 403, detail: "This operation is not allowed.",
      instance: "/api/ui/v1/conversations", code: "forbidden", requestId: "5af093d0-84f1-4759-a92e-bbe2949ab957",
    });
    const handler = createListConversationsHandler({
      listConversations: vi.fn(async () => { throw forbidden; }),
    } as unknown as HermesGateway, policy);
    const response = await handler(
      new Request("https://pih.example/api/ui/v1/conversations", { headers: headers() }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden", detail: "This operation is not allowed." });
  });

  it("returns dependency unavailable when the connector gateway is null", async () => {
    const handler = createListConversationsHandler(null, policy);
    const response = await handler(new Request("https://pih.example/api/ui/v1/conversations", { headers: headers() }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "dependency_unavailable" });
  });
});
