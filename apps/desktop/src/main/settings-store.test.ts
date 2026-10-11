import * as filesystem from "node:fs/promises";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsStore } from "./settings-store.js";

// Wrap only the module namespace so the test can observe real writes at their boundary.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof filesystem>(),
}));

const defaults = { serverOrigin: null, launchAtLogin: false };
let directory: string;
let settingsPath: string;
let store: SettingsStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "desktop-settings-"));
  settingsPath = join(directory, "settings.json");
  store = new SettingsStore(directory);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("SettingsStore", () => {
  it("returns defaults when no settings exist", async () => {
    expect(await store.read()).toEqual(defaults);
  });

  it("writes private normalized preferences and reads them back", async () => {
    await store.write({ serverOrigin: "https://HUB.example.test:443/", launchAtLogin: true });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      serverOrigin: "https://hub.example.test", launchAtLogin: true,
    });
    expect(await store.read()).toEqual({ serverOrigin: "https://hub.example.test", launchAtLogin: true });
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  it("atomically replaces the previous file and removes the temporary file", async () => {
    await writeFile(settingsPath, JSON.stringify(defaults), { mode: 0o644 });
    const previous = await open(settingsPath, "r");
    try {
      await store.write({ serverOrigin: "https://hub.example.test", launchAtLogin: true });
      expect(JSON.parse(await previous.readFile("utf8"))).toEqual(defaults);
      expect(await store.read()).toEqual({ serverOrigin: "https://hub.example.test", launchAtLogin: true });
      expect(await readdir(directory)).toEqual(["settings.json"]);
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    } finally { await previous.close(); }
  });

  it("restricts a reused temporary file before writing settings bytes", async () => {
    const temporaryPath = join(directory, "settings.json.tmp");
    await writeFile(temporaryPath, "", { mode: 0o644 });
    await filesystem.chmod(temporaryPath, 0o644);
    const existing = await open(temporaryPath, "r");
    const originalWriteFile = filesystem.writeFile;
    let modeDuringWrite: number | undefined;
    const writer = vi.spyOn(filesystem, "writeFile").mockImplementation(async (...arguments_) => {
      modeDuringWrite = (await existing.stat()).mode & 0o777;
      return originalWriteFile(...arguments_);
    });
    try {
      const previousInode = (await existing.stat()).ino;
      await store.write(defaults);
      expect(modeDuringWrite).toBe(0o600);
      expect((await stat(settingsPath)).ino).toBe(previousInode);
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toEqual(["settings.json"]);
    } finally {
      writer.mockRestore();
      await existing.close();
    }
  });

  it("persists only allowed keys even when extra properties arrive at runtime", async () => {
    const settings = { ...defaults, token: "fixture-secret", password: "fixture-secret", records: ["fixture"] };
    await store.write(settings);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(defaults);
  });

  it("ignores unknown keys when reading and normalizes valid origins", async () => {
    await writeFile(settingsPath, JSON.stringify({ serverOrigin: "https://HUB.example.test/", launchAtLogin: true, token: "fixture-secret" }));
    expect(await store.read()).toEqual({ serverOrigin: "https://hub.example.test", launchAtLogin: true });
  });

  it.each(["{broken", "null", "[]", "{}", JSON.stringify({ serverOrigin: 7, launchAtLogin: false }), JSON.stringify({ serverOrigin: null, launchAtLogin: "true" }), JSON.stringify({ serverOrigin: "https://user:fixture-secret@hub.example.test", launchAtLogin: true }), JSON.stringify({ serverOrigin: "https://hub.example.test/private", launchAtLogin: true }), JSON.stringify({ serverOrigin: "http://localhost:3000", launchAtLogin: true })])("recovers invalid stored settings %s to defaults", async (raw) => {
    await writeFile(settingsPath, raw);
    expect(await store.read()).toEqual(defaults);
  });

  it("rejects invalid writes without replacing existing settings or exposing input", async () => {
    await store.write(defaults);
    await expect(store.write({ serverOrigin: "https://user:fixture-secret@hub.example.test", launchAtLogin: false })).rejects.toThrow("Invalid desktop settings");
    await expect(store.write({ serverOrigin: null, launchAtLogin: "true" } as never)).rejects.toThrow("Invalid desktop settings");
    expect(await store.read()).toEqual(defaults);
    expect(await readdir(directory)).toEqual(["settings.json"]);
  });

  it("permits HTTP loopback only with explicit development permission", async () => {
    const developmentStore = new SettingsStore(directory, { allowInsecureLoopback: true });
    await developmentStore.write({ serverOrigin: "http://localhost:3000/", launchAtLogin: false });
    expect(await developmentStore.read()).toEqual({ serverOrigin: "http://localhost:3000", launchAtLogin: false });
  });

  it("serializes overlapping writes so each replacement completes", async () => {
    await Promise.all([
      store.write({ serverOrigin: "https://first.example.test", launchAtLogin: false }),
      store.write({ serverOrigin: "https://second.example.test", launchAtLogin: true }),
    ]);
    expect(await store.read()).toEqual({ serverOrigin: "https://second.example.test", launchAtLogin: true });
    expect(await readdir(directory)).toEqual(["settings.json"]);
  });
});
