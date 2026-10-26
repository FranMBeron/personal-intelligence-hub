import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorsDelegationClient } from "../delegation-client.js";
import type { UnixHttpTransport } from "../unix-http-transport.js";
import { createCentralDelegationTool } from "./delegate-agent.js";
import * as tools from "./index.js";
import { createHermesTools } from "./index.js";

const delegation = {
  id: "delegation-01", sourceAgentId: "orchestrator", targetAgentId: "fitness", sourceConversationId: null,
  state: "queued", createdAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z",
};
const setup = () => {
  const transport = { postJson: vi.fn<UnixHttpTransport["postJson"]>(async () => ({ status: 201, body: delegation })) };
  const client = new ConnectorsDelegationClient({
    socketPath: "/run/pih-connectors/agents/hermes-delegation.sock",
    credentialsByTarget: new Map([["fitness", "fictional-fitness-peer-token-32-bytes"]]),
    transport,
  });
  const keyOf = (call: number) => transport.postJson.mock.calls[call]![0].headers["idempotency-key"];
  return { transport, keyOf, tool: createCentralDelegationTool(client) };
};

afterEach(() => { vi.unstubAllEnvs(); });

describe("createCentralDelegationTool", () => {
  it("delegates only through the narrow client and agent-only socket", async () => {
    const { transport, tool } = setup();
    await tool.execute({ targetAgentId: "fitness", message: "Revisá la tendencia semanal." });
    expect(transport.postJson).toHaveBeenCalledWith(expect.objectContaining({
      socketPath: "/run/pih-connectors/agents/hermes-delegation.sock",
      path: "/internal/v1/hermes/delegations",
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer fictional-fitness-peer-token-32-bytes",
        "idempotency-key": expect.any(String),
      }),
    }));
  });

  it("forwards a well-formed HERMES_SESSION_ID, read on every call, only as the source session", async () => {
    const { transport, tool } = setup();
    vi.stubEnv("HERMES_SESSION_ID", "pih_conversation-01");
    await tool.execute({ targetAgentId: "fitness", message: "Hola" });
    expect(JSON.parse(transport.postJson.mock.calls[0]![0].body)).toEqual({ targetAgentId: "fitness", message: "Hola", sourceSessionId: "pih_conversation-01" });
    vi.stubEnv("HERMES_SESSION_ID", "../../etc/passwd");
    await tool.execute({ targetAgentId: "fitness", message: "Hola" });
    expect(JSON.parse(transport.postJson.mock.calls[1]![0].body)).toEqual({ targetAgentId: "fitness", message: "Hola" });
  });

  it("prefers the session from the Hermes call context over the process environment", async () => {
    const { transport, tool } = setup();
    vi.stubEnv("HERMES_SESSION_ID", "pih_conversation-env");
    await tool.execute({ targetAgentId: "fitness", message: "Hola" }, { sessionId: "pih_conversation-ctx" });
    expect(JSON.parse(transport.postJson.mock.calls[0]![0].body)).toMatchObject({ sourceSessionId: "pih_conversation-ctx" });
  });

  it("derives one deterministic idempotency key per logical delegation so a retried call dedupes", async () => {
    const { tool, keyOf } = setup();
    vi.stubEnv("HERMES_SESSION_ID", "pih_conversation-01");
    const input = { targetAgentId: "fitness", message: "Revisá la tendencia semanal." };
    await tool.execute(input);
    await tool.execute({ ...input });
    expect(keyOf(1)).toBe(keyOf(0));
    expect(keyOf(0)).toMatch(/^[\x21-\x7e]{8,255}$/u);
    await tool.execute({ ...input, message: "Otra cosa" });
    expect(keyOf(2)).not.toBe(keyOf(0));
    vi.stubEnv("HERMES_SESSION_ID", "pih_conversation-02");
    await tool.execute(input);
    expect(keyOf(3)).not.toBe(keyOf(0));
  });

  it("a retried execute replays the same server-side delegation instead of creating another", async () => {
    // Fictional server double with idempotent replay: one delegation per idempotency key.
    const byKey = new Map<string, typeof delegation>();
    const transport = { postJson: vi.fn<UnixHttpTransport["postJson"]>(async ({ headers }) => {
      const key = headers["idempotency-key"]!;
      if (!byKey.has(key)) byKey.set(key, { ...delegation, id: `delegation-0${byKey.size + 1}` });
      return { status: 201, body: byKey.get(key) };
    }) };
    const tool = createCentralDelegationTool(new ConnectorsDelegationClient({
      socketPath: "/run/pih-connectors/agents/hermes-delegation.sock",
      credentialsByTarget: new Map([["fitness", "fictional-fitness-peer-token-32-bytes"]]),
      transport,
    }));
    const input = { targetAgentId: "fitness", message: "Revisá la tendencia semanal." };
    const first = await tool.execute(input, { sessionId: "pih_conversation-01" });
    const retried = await tool.execute(input, { sessionId: "pih_conversation-01" });
    expect(retried).toEqual(first);
    expect(byKey.size).toBe(1);
  });

  it("keys on the Hermes tool-call id when the call context provides one", async () => {
    const { tool, keyOf } = setup();
    const input = { targetAgentId: "fitness", message: "Hola" };
    await tool.execute(input, { toolCallId: "call_fictional_01" });
    await tool.execute(input, { toolCallId: "call_fictional_01" });
    await tool.execute(input, { toolCallId: "call_fictional_02" });
    await tool.execute(input);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(keyOf(2)).not.toBe(keyOf(0));
    expect(keyOf(3)).not.toBe(keyOf(0));
  });

  it("exposes a strict two-field schema with no origin, method, path, command, or credential input", () => {
    const { tool } = setup();
    expect(tool.inputSchema.safeParse({ targetAgentId: "fitness", message: "x" }).success).toBe(true);
    for (const extra of [{ url: "http://127.0.0.1" }, { method: "GET" }, { path: "/v1/x" }, { command: "ls" }, { token: "x" }]) {
      expect(tool.inputSchema.safeParse({ targetAgentId: "fitness", message: "x", ...extra }).success).toBe(false);
    }
    expect(Object.keys(tool.inputSchema.shape).sort()).toEqual(["message", "targetAgentId"]);
  });
});

describe("createHermesTools", () => {
  it("never includes the Central-only delegation tool, so specialists cannot receive it", () => {
    const set = createHermesTools({} as never);
    expect(Object.keys(set).some((name) => /delegat/iu.test(name))).toBe(false);
    for (const tool of Object.values(set) as { inputSchema?: { shape?: Record<string, unknown> } }[]) {
      expect(Object.keys(tool.inputSchema?.shape ?? {})).not.toContain("targetAgentId");
    }
    expect(tools).not.toHaveProperty("createDelegateAgentTool");
    expect(typeof tools.createCentralDelegationTool).toBe("function");
  });
});
