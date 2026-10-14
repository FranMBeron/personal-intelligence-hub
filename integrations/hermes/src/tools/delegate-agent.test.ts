import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorsDelegationClient } from "../delegation-client.js";
import type { UnixHttpTransport } from "../unix-http-transport.js";
import { createDelegateAgentTool } from "./delegate-agent.js";
import { createHermesTools } from "./index.js";

const delegation = {
  id: "delegation-01", sourceAgentId: "orchestrator", targetAgentId: "fitness", sourceConversationId: null,
  state: "queued", createdAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z",
};
const setup = () => {
  const transport = { postJson: vi.fn<UnixHttpTransport["postJson"]>(async () => ({ status: 201, body: delegation })) };
  const client = new ConnectorsDelegationClient({
    socketPath: "/run/pih-connectors/hermes-delegation.sock",
    credentialsByTarget: new Map([["fitness", "fictional-fitness-peer-token-32-bytes"]]),
    transport,
    idempotencyKeyFactory: () => "delegation-key-0001",
  });
  return { transport, tool: createDelegateAgentTool(client) };
};

afterEach(() => { vi.unstubAllEnvs(); });

describe("createDelegateAgentTool", () => {
  it("delegates only through the narrow client and agent-only socket", async () => {
    const { transport, tool } = setup();
    await tool.execute({ targetAgentId: "fitness", message: "Revisá la tendencia semanal." });
    expect(transport.postJson).toHaveBeenCalledWith(expect.objectContaining({
      socketPath: "/run/pih-connectors/hermes-delegation.sock",
      path: "/internal/v1/hermes/delegations",
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer fictional-fitness-peer-token-32-bytes",
        "idempotency-key": expect.any(String),
      }),
    }));
  });

  it("forwards a well-formed HERMES_SESSION_ID only as the source session", async () => {
    const { transport, tool } = setup();
    vi.stubEnv("HERMES_SESSION_ID", "pih_conversation-01");
    await tool.execute({ targetAgentId: "fitness", message: "Hola" });
    expect(JSON.parse(transport.postJson.mock.calls[0]![0].body)).toEqual({ targetAgentId: "fitness", message: "Hola", sourceSessionId: "pih_conversation-01" });
    vi.stubEnv("HERMES_SESSION_ID", "../../etc/passwd");
    await tool.execute({ targetAgentId: "fitness", message: "Hola" });
    expect(JSON.parse(transport.postJson.mock.calls[1]![0].body)).toEqual({ targetAgentId: "fitness", message: "Hola" });
  });

  it("exposes a strict two-field schema with no origin, method, path, command, or credential input", () => {
    const { tool } = setup();
    expect(tool.inputSchema.safeParse({ targetAgentId: "fitness", message: "x" }).success).toBe(true);
    for (const extra of [{ url: "http://127.0.0.1" }, { method: "GET" }, { path: "/v1/x" }, { command: "ls" }, { token: "x" }]) {
      expect(tool.inputSchema.safeParse({ targetAgentId: "fitness", message: "x", ...extra }).success).toBe(false);
    }
    expect(Object.keys(tool.inputSchema.shape).sort()).toEqual(["message", "targetAgentId"]);
  });

  it("is not part of the Second Brain tool set", () => {
    expect(Object.keys(createHermesTools({} as never))).not.toContain("delegateAgent");
  });
});
