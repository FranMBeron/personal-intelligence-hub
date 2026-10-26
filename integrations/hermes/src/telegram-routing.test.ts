import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildTelegramProfileRoutes } from "./telegram-routing.js";

/** Fictional profile slugs and chat IDs only. */
const valid = {
  defaultProfileId: "orchestrator",
  specialistRoutes: [
    { profileId: "specialist-a", chatId: "-1000000000001" },
    { profileId: "specialist-b", chatId: "-1000000000002" },
  ],
};

const expectRejected = (input: unknown) => {
  let thrown: unknown;
  try {
    buildTelegramProfileRoutes(input as never);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  // Errors carry a closed message only: never a chat ID, profile ID, or input echo.
  expect((thrown as Error).message).toBe("Telegram profile routing configuration is invalid");
  return thrown as Error;
};

describe("buildTelegramProfileRoutes", () => {
  it("builds the native multiplex block with a closed allowlist and exact routes", () => {
    expect(buildTelegramProfileRoutes(valid)).toEqual({
      multiplex_profiles: true,
      multiplex_profile_allowlist: ["orchestrator", "specialist-a", "specialist-b"],
      profile_routes: [
        { name: "telegram-specialist-a", platform: "telegram", chat_id: "-1000000000001", profile: "specialist-a" },
        { name: "telegram-specialist-b", platform: "telegram", chat_id: "-1000000000002", profile: "specialist-b" },
      ],
    });
  });

  it("accepts a basic (non-supergroup) negative group ID", () => {
    const routes = buildTelegramProfileRoutes({
      defaultProfileId: "orchestrator", specialistRoutes: [{ profileId: "specialist-a", chatId: "-4000000001" }],
    });
    expect(routes.profile_routes).toEqual([
      { name: "telegram-specialist-a", platform: "telegram", chat_id: "-4000000001", profile: "specialist-a" },
    ]);
  });

  it("returns frozen output that cannot be altered after validation", () => {
    const routes = buildTelegramProfileRoutes(valid);
    expect(Object.isFrozen(routes)).toBe(true);
    expect(Object.isFrozen(routes.multiplex_profile_allowlist)).toBe(true);
    expect(Object.isFrozen(routes.profile_routes)).toBe(true);
    expect(routes.profile_routes.every((route) => Object.isFrozen(route))).toBe(true);
  });

  it("rejects duplicate chat IDs", () => {
    expectRejected({
      defaultProfileId: "orchestrator",
      specialistRoutes: [
        { profileId: "specialist-a", chatId: "-1000000000001" },
        { profileId: "specialist-b", chatId: "-1000000000001" },
      ],
    });
  });

  it("rejects duplicate specialist profiles", () => {
    expectRejected({
      defaultProfileId: "orchestrator",
      specialistRoutes: [
        { profileId: "specialist-a", chatId: "-1000000000001" },
        { profileId: "specialist-a", chatId: "-1000000000002" },
      ],
    });
  });

  it("rejects the default profile as a specialist target", () => {
    expectRejected({
      defaultProfileId: "orchestrator",
      specialistRoutes: [{ profileId: "orchestrator", chatId: "-1000000000001" }],
    });
  });

  it.each([
    ["non-numeric", "-100abc"],
    ["username", "@fictional_group"],
    ["empty", ""],
    ["leading zero", "-0100000000001"],
    ["zero", "0"],
    ["minus zero", "-0"],
    ["decimal", "-1000000000001.5"],
    ["whitespace", " -1000000000001"],
    ["too long", "-1" + "0".repeat(25)],
  ])("rejects a %s chat ID", (_label, chatId) => {
    expectRejected({ defaultProfileId: "orchestrator", specialistRoutes: [{ profileId: "specialist-a", chatId }] });
  });

  it("rejects a numeric chat ID that is not a string", () => {
    expectRejected({ defaultProfileId: "orchestrator", specialistRoutes: [{ profileId: "specialist-a", chatId: -1000000000001 }] });
  });

  it.each(["1000000000001", "+1000000000001", "42"])("rejects a positive (private chat or user) ID %s", (chatId) => {
    expectRejected({ defaultProfileId: "orchestrator", specialistRoutes: [{ profileId: "specialist-a", chatId }] });
  });

  it("rejects an empty specialist route list (keep the single default route instead)", () => {
    expectRejected({ defaultProfileId: "orchestrator", specialistRoutes: [] });
  });

  it.each(["", "Orchestrator", "1profile", "profile_a", "a".repeat(64)])("rejects an invalid profile slug %j", (profileId) => {
    expectRejected({ defaultProfileId: "orchestrator", specialistRoutes: [{ profileId, chatId: "-1000000000001" }] });
    expectRejected({ defaultProfileId: profileId, specialistRoutes: [{ profileId: "specialist-a", chatId: "-1000000000001" }] });
  });

  it.each([
    ["top-level field", { ...valid, botToken: "fictional-token" }],
    ["route field", { defaultProfileId: "orchestrator", specialistRoutes: [{ profileId: "specialist-a", chatId: "-1000000000001", senderAllowlist: [] }] }],
    ["missing default", { specialistRoutes: valid.specialistRoutes }],
    ["missing routes", { defaultProfileId: "orchestrator" }],
    ["non-object", "orchestrator"],
    ["null", null],
  ])("rejects unknown or malformed input: %s", (_label, input) => {
    expectRejected(input);
  });

  it("rejects more routes than the bounded ceiling", () => {
    expectRejected({
      defaultProfileId: "orchestrator",
      specialistRoutes: Array.from({ length: 33 }, (_, index) => ({
        profileId: `specialist-${index}`, chatId: `-10000000${String(index + 1).padStart(5, "0")}`,
      })),
    });
  });

  it("never echoes the rejected chat ID in the error", () => {
    const error = expectRejected({
      defaultProfileId: "orchestrator",
      specialistRoutes: [{ profileId: "specialist-a", chatId: "1234567890123" }],
    });
    expect(error.message).not.toContain("1234567890123");
    expect(JSON.stringify(error)).not.toContain("1234567890123");
    expect(error.cause).toBeUndefined();
  });
});

describe("gateway.multiplex.example.yaml", () => {
  const examplePath = new URL("../config/gateway.multiplex.example.yaml", import.meta.url);

  it("matches the route builder for its fictional values", async () => {
    const example = await readFile(examplePath, "utf8");
    const allowlist = [...example.matchAll(/^ {4}- ([a-z][a-z0-9-]*)\s*$/gmu)].map((match) => match[1]!);
    const routes = [...example.matchAll(
      /- name: (\S+)\n\s+platform: (\S+)\n\s+chat_id: "(-?\d+)"\n\s+profile: (\S+)/gu,
    )].map((match) => ({ name: match[1], platform: match[2], chat_id: match[3], profile: match[4] }));
    expect(example).toMatch(/^gateway:\n {2}multiplex_profiles: true\n/mu);
    const built = buildTelegramProfileRoutes({
      defaultProfileId: allowlist[0]!,
      specialistRoutes: routes.map((route) => ({ profileId: route.profile!, chatId: route.chat_id! })),
    });
    expect(allowlist).toEqual(built.multiplex_profile_allowlist);
    expect(routes).toEqual(built.profile_routes);
  });

  it("contains no credential, sender allowlist value, or non-fictional chat ID", async () => {
    const example = await readFile(examplePath, "utf8");
    const uncommented = example.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(uncommented).not.toMatch(/token|api_key|secret|password|allowed_users|allow_from/iu);
    const chatIds = [...example.matchAll(/-?\d{6,}/gu)].map((match) => match[0]);
    expect(chatIds.length).toBeGreaterThan(0);
    expect(chatIds.every((id) => /^-10{11}[1-9]$/u.test(id))).toBe(true);
  });
});
