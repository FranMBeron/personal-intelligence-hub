import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { agentFixture } from "@personal-intelligence-hub/contracts/testing/connectors";
import { describe, expect, it } from "vitest";

import { resolveCentralEntry } from "./central";

const capabilities: HermesCapabilities = {
  text: true, streaming: false, voice: { enabled: false },
  attachments: { enabled: false, acceptedMimeTypes: [], maxFiles: 1, maxBytes: 1024 }, agentConversations: true,
};
const loaded = <T,>(value: T) => ({ state: "loaded" as const, value });

describe("resolveCentralEntry", () => {
  it("uses the configured profile id and the roster display name", () => {
    const result = resolveCentralEntry("coordinator-custom", loaded(capabilities), loaded([agentFixture({ id: "coordinator-custom", displayName: "Planner" })]));
    expect(result).toEqual({ profile: { id: "coordinator-custom", displayName: "Planner" }, capabilities, sourceState: "available" });
  });

  it("has no profile when the installation does not name one", () => {
    expect(resolveCentralEntry(null, loaded(capabilities), loaded([]))).toEqual({ profile: null, capabilities: null, sourceState: "not_configured" });
  });

  it("separates an unconfigured Hermes from a failing one", () => {
    expect(resolveCentralEntry("central", { state: "not_configured" }, { state: "not_configured" }).sourceState).toBe("not_configured");
    expect(resolveCentralEntry("central", { state: "unavailable" }, { state: "unavailable" })).toEqual({
      profile: { id: "central", displayName: "central" }, capabilities: null, sourceState: "unavailable",
    });
  });

  it("does not offer a profile the roster answered without", () => {
    expect(resolveCentralEntry("central", loaded(capabilities), loaded([agentFixture({ id: "other" })])).sourceState).toBe("unavailable");
  });

  it("keeps the entry usable when only the roster read failed", () => {
    const result = resolveCentralEntry("central", loaded(capabilities), { state: "unavailable" });
    expect(result).toEqual({ profile: { id: "central", displayName: "central" }, capabilities, sourceState: "available" });
  });
});
