import { describe, expect, it } from "vitest";

import { loadServerConfig } from "./server";

describe("loadServerConfig", () => {
  it("uses the local PIH API default without configuring Hermes", () => {
    expect(loadServerConfig({})).toEqual({
      pihApiInternalUrl: "http://127.0.0.1:3001/",
    });
  });

  it("accepts a complete server-only Hermes configuration", () => {
    expect(
      loadServerConfig({
        PIH_API_INTERNAL_URL: "https://api.example.test/base",
        HERMES_INTERNAL_URL: "https://hermes.example.test",
        HERMES_SERVICE_TOKEN: "fictional-service-token",
        HERMES_DASHBOARD_URL: "https://dashboard.example.test/hermes",
      }),
    ).toEqual({
      pihApiInternalUrl: "https://api.example.test/base",
      hermesInternalUrl: "https://hermes.example.test/",
      hermesServiceToken: "fictional-service-token",
      hermesDashboardUrl: "https://dashboard.example.test/hermes",
    });
  });

  it("requires Hermes URL and token together", () => {
    expect(() =>
      loadServerConfig({ HERMES_INTERNAL_URL: "https://hermes.example.test" }),
    ).toThrow(/configured together/u);
    expect(() =>
      loadServerConfig({ HERMES_SERVICE_TOKEN: "fictional-service-token" }),
    ).toThrow(/configured together/u);
  });

  it("rejects credentialed or non-HTTP destinations", () => {
    expect(() =>
      loadServerConfig({
        PIH_API_INTERNAL_URL: "https://user:secret@example.test",
      }),
    ).toThrow(/uncredentialed/u);
    expect(() =>
      loadServerConfig({ PIH_API_INTERNAL_URL: "file:///tmp/pih.sock" }),
    ).toThrow(/HTTP\(S\)/u);
  });
});
