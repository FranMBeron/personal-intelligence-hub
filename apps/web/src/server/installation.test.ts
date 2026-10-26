import { describe, expect, it } from "vitest";

import { loadInstallationSettings } from "./installation";

describe("loadInstallationSettings", () => {
  it("leaves the Central profile and device connection unconfigured by default", () => {
    expect(loadInstallationSettings({})).toEqual({ centralAgentId: null, deviceConnectionId: null });
    expect(loadInstallationSettings({ PIH_CENTRAL_AGENT_ID: "", PIH_DEVICE_CONNECTION_ID: "" })).toEqual({ centralAgentId: null, deviceConnectionId: null });
  });

  it("accepts any configured profile id rather than a product-specific one", () => {
    expect(loadInstallationSettings({ PIH_CENTRAL_AGENT_ID: "coordinator-custom", PIH_DEVICE_CONNECTION_ID: "example-band" })).toEqual({
      centralAgentId: "coordinator-custom",
      deviceConnectionId: "example-band",
    });
  });

  it("refuses invalid values instead of silently ignoring them", () => {
    expect(() => loadInstallationSettings({ PIH_DEVICE_CONNECTION_ID: "Not Valid" })).toThrow("PIH_DEVICE_CONNECTION_ID is invalid.");
    expect(() => loadInstallationSettings({ PIH_CENTRAL_AGENT_ID: " ".repeat(3) })).toThrow("PIH_CENTRAL_AGENT_ID is invalid.");
  });
});
