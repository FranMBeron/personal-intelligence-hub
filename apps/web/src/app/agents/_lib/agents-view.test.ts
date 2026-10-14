import { agentFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { describe, expect, it } from "vitest";

import { buildAgentsView, filterAgents, parseAgentFilter } from "./agents-view";

const metric = (view: ReturnType<typeof buildAgentsView>, id: string) => {
  const found = view.metrics.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing metric ${id}`);
  return found;
};

describe("buildAgentsView", () => {
  it.each(["unavailable", "not_configured"] as const)("never reports zero when the roster is %s", (state) => {
    const view = buildAgentsView({ state });
    expect(view.counts).toEqual({ total: null, available: null, working: null, ready: null, attention: null });
    for (const item of view.metrics) {
      expect(item.value).toBe("No disponible");
      expect(item.value).not.toBe("0");
    }
    expect(view.metrics.map((item) => item.detail)).not.toContain("Sin bloqueos");
  });

  it("reports a real zero for a successful empty roster", () => {
    const view = buildAgentsView({ state: "available", agents: [] });
    expect(view.counts).toEqual({ total: 0, available: 0, working: 0, ready: 0, attention: 0 });
    expect(metric(view, "attention")).toMatchObject({ value: "0", detail: "Sin bloqueos" });
  });

  it("keeps availability, execution, result and attention independent", () => {
    const view = buildAgentsView({
      state: "available",
      agents: [
        agentFixture({ id: "a", availability: "online", execution: "working", result: "none", attention: "none" }),
        agentFixture({ id: "b", availability: "online", execution: "waiting", result: "none", attention: "none" }),
        agentFixture({ id: "c", availability: "offline", execution: "idle", result: "ready", attention: "required" }),
      ],
    });
    expect(view.counts).toEqual({ total: 3, available: 2, working: 1, ready: 1, attention: 1 });
  });

  it("does not count waiting or unknown as a completed result", () => {
    const view = buildAgentsView({
      state: "available",
      agents: [
        agentFixture({ id: "waiting", execution: "waiting", result: "none" }),
        agentFixture({ id: "unknown", execution: "unknown", result: "unknown" }),
      ],
    });
    expect(view.counts.ready).toBe(0);
    expect(metric(view, "ready").value).toBe("0");
    expect(metric(view, "ready").detail).toContain("1 sin datos");
  });

  it("orders real activity by the reported check time, newest first", () => {
    const view = buildAgentsView({
      state: "available",
      agents: [
        agentFixture({ id: "older", execution: "working", checkedAt: "2026-10-12T10:00:00.000Z" }),
        agentFixture({ id: "idle", execution: "idle", result: "none", attention: "none" }),
        agentFixture({ id: "newer", result: "ready", checkedAt: "2026-10-12T11:00:00.000Z" }),
        agentFixture({ id: "blocked", attention: "required", checkedAt: "2026-10-12T09:00:00.000Z" }),
      ],
    });
    expect(view.activity.map((item) => [item.agentId, item.kind])).toEqual([
      ["newer", "result"],
      ["older", "working"],
      ["blocked", "attention"],
    ]);
  });
});

describe("filters", () => {
  const agents = [
    agentFixture({ id: "Perfil de investigación ñ/1", execution: "working", attention: "none" }),
    agentFixture({ id: "waiting", execution: "waiting", attention: "none" }),
    agentFixture({ id: "alert", execution: "idle", attention: "required" }),
    agentFixture({ id: "unknown", execution: "unknown", attention: "unknown" }),
  ];

  it("filters working agents and agents with alerts from their own fields", () => {
    expect(filterAgents(agents, "all").map(({ id }) => id)).toHaveLength(4);
    expect(filterAgents(agents, "active").map(({ id }) => id)).toEqual(["Perfil de investigación ñ/1"]);
    expect(filterAgents(agents, "attention").map(({ id }) => id)).toEqual(["alert"]);
  });

  it.each([
    [null, "all"],
    ["active", "active"],
    ["attention", "attention"],
    ["ACTIVE", "all"],
    ["<script>", "all"],
  ] as const)("parses %s as %s", (value, expected) => {
    expect(parseAgentFilter(value)).toBe(expected);
  });
});
