import { describe, expect, it, vi } from "vitest";

import { ConnectorsDelegationClient, DelegationClientError } from "./delegation-client.js";
import type { UnixHttpTransport } from "./unix-http-transport.js";

const socketPath = "/run/pih-connectors/hermes-delegation.sock";
const tokenA = "fictional-specialist-a-peer-token-32-bytes";
const tokenB = "fictional-specialist-b-peer-token-32-bytes";
const delegation = {
  id: "delegation-01", sourceAgentId: "orchestrator", targetAgentId: "specialist-a", sourceConversationId: null,
  state: "running", createdAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z",
};

const transportReturning = (status: number, body: unknown) => ({
  postJson: vi.fn<UnixHttpTransport["postJson"]>(async () => ({ status, body })),
});
const clientWith = (transport: UnixHttpTransport, credentials: [string, string][] = [["specialist-a", tokenA], ["specialist-b", tokenB]]) =>
  new ConnectorsDelegationClient({
    socketPath, credentialsByTarget: new Map(credentials), transport, idempotencyKeyFactory: () => "delegation-key-0001",
  });

describe("ConnectorsDelegationClient", () => {
  it("posts only to the fixed agent-only route with the target's own credential in the header", async () => {
    const transport = transportReturning(201, delegation);
    const result = await clientWith(transport).start({ targetAgentId: "specialist-a", message: "Revisá esto.", sourceSessionId: "pih_conversation-01" });
    expect(result).toEqual(delegation);
    expect(transport.postJson).toHaveBeenCalledWith({
      socketPath, path: "/internal/v1/hermes/delegations", method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json", "idempotency-key": "delegation-key-0001" },
      body: JSON.stringify({ targetAgentId: "specialist-a", message: "Revisá esto.", sourceSessionId: "pih_conversation-01" }),
    });
    expect(transport.postJson.mock.calls[0]?.[0].body).not.toContain(tokenA);
    expect(JSON.stringify(result)).not.toContain(tokenA);
  });

  it("selects the credential strictly by validated target and fails unknown targets before any I/O", async () => {
    const transport = transportReturning(201, { ...delegation, targetAgentId: "specialist-b" });
    const client = clientWith(transport);
    await client.start({ targetAgentId: "specialist-b", message: "Hola" });
    expect(transport.postJson.mock.calls[0]?.[0].headers.authorization).toBe(`Bearer ${tokenB}`);
    for (const targetAgentId of ["orchestrator", "shell", "../specialist-a", "SPECIALIST-A", ""]) {
      await expect(client.start({ targetAgentId, message: "Hola" })).rejects.toMatchObject({ code: "delegation_target_unknown" });
    }
    await expect(client.start({ targetAgentId: "specialist-a", message: "" })).rejects.toMatchObject({ code: "delegation_request_invalid" });
    await expect(client.start({ targetAgentId: "specialist-a", message: "x", extra: true } as never)).rejects.toMatchObject({ code: "delegation_request_invalid" });
    expect(transport.postJson).toHaveBeenCalledTimes(1);
  });

  it("rejects responses that are not a delegation for the requested target", async () => {
    await expect(clientWith(transportReturning(201, { ...delegation, state: "unknown" })).start({ targetAgentId: "specialist-a", message: "x" }))
      .rejects.toMatchObject({ code: "delegation_response_invalid" });
    await expect(clientWith(transportReturning(201, { ...delegation, targetAgentId: "specialist-b" })).start({ targetAgentId: "specialist-a", message: "x" }))
      .rejects.toMatchObject({ code: "delegation_response_invalid" });
  });

  it("maps error responses to closed codes", async () => {
    await expect(clientWith(transportReturning(409, { code: "idempotency_key_reused" })).start({ targetAgentId: "specialist-a", message: "x" }))
      .rejects.toEqual(new DelegationClientError("idempotency_key_reused"));
    await expect(clientWith(transportReturning(500, { code: "leaked /var/lib/detail" })).start({ targetAgentId: "specialist-a", message: "x" }))
      .rejects.toMatchObject({ code: "delegation_failed" });
  });

  it.each([
    ["a relative socket path", { socketPath: "run/hermes-delegation.sock" }],
    ["the BFF socket", { socketPath: "/run/pih-connectors/web/connectors.sock" }],
    ["the BFF socket as mounted in web", { socketPath: "/run/pih-connectors/connectors.sock" }],
    ["no credentials", { credentialsByTarget: new Map() }],
    ["a short credential", { credentialsByTarget: new Map([["specialist-a", "short"]]) }],
    ["a duplicated credential", { credentialsByTarget: new Map([["specialist-a", tokenA], ["specialist-b", tokenA]]) }],
    ["an invalid target ID", { credentialsByTarget: new Map([["Specialist A", tokenA]]) }],
  ])("refuses construction with %s", (_name, overrides) => {
    expect(() => new ConnectorsDelegationClient({
      socketPath, credentialsByTarget: new Map([["specialist-a", tokenA]]), transport: transportReturning(201, delegation),
      idempotencyKeyFactory: () => "delegation-key-0001", ...overrides,
    })).toThrow();
  });
});
