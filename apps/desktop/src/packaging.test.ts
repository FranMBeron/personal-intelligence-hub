import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import config from "../forge.config.js";

describe("unsigned desktop packaging policy", () => {
  it("packages with ASAR and the generic application identity and approved icon", () => {
    expect(config.packagerConfig).toMatchObject({
      asar: true, name: "Personal Intelligence Hub",
      executableName: "personal-intelligence-hub",
      appBundleId: "org.personal-intelligence-hub.desktop", icon: "assets/icon",
    });
    expect(config).toHaveProperty("outDir", "out");
  });

  it("creates only a Darwin DMG and refuses every architecture except arm64", () => {
    expect(config.makers).toHaveLength(1);
    const maker = config.makers[0];
    expect(maker).toMatchObject({ name: "@electron-forge/maker-dmg", platforms: ["darwin"] });
    if (!maker || !("config" in maker) || typeof maker.config !== "function") {
      throw new Error("DMG maker must validate its target architecture");
    }
    expect(maker.config("arm64")).toEqual({ format: "ULFO", name: "Personal Intelligence Hub" });
    for (const arch of ["x64", "ia32", "armv7l", "universal", "all"]) {
      expect(() => maker.config(arch)).toThrow(/arm64/);
    }
  });

  it("makes arm64 macOS explicitly while the build packages only the host platform", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.scripts["make:mac"]).toBe("electron-forge make --platform=darwin --arch=arm64");
    expect(manifest.scripts.build).toBe("electron-forge package");
    expect(Object.keys(manifest.scripts).some((key) => /publish|sign|notari|update/i.test(key))).toBe(false);
  });

  it("has no publishing, signing, notarization, update, URL, or credential configuration", () => {
    const inspect = (value: unknown): void => {
      if (typeof value === "string") expect(value).not.toMatch(/(?:https?|wss?):\/\//);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        expect(key).not.toMatch(/sign|notari|publish|updat|url|token|password|secret|credential/i);
        inspect(child);
      }
    };
    inspect(config);
  });

  it("allows only the bundled local runtime and excludes source, settings, credentials and outputs", () => {
    const ignore = config.packagerConfig.ignore;
    expect(typeof ignore).toBe("function");
    if (typeof ignore !== "function") throw new Error("Package file allowlist is required");
    for (const path of ["", "/package.json", "/.vite", "/.vite/build", "/.vite/build/main.cjs",
      "/.vite/build/preload.cjs", "/.vite/renderer", "/.vite/renderer/index.html",
      "/.vite/renderer/assets", "/.vite/renderer/assets/index.js", "/.vite/renderer/assets/index.css"]) {
      expect(ignore(path), path).toBe(false);
    }
    for (const path of ["/.env", "/settings.json", "/credentials", "/src", "/node_modules",
      "/out", "/out/application.dmg", "/assets", "/forge.config.ts", "/.vite/settings.json",
      "/.vite/build/debug.cjs", "/.vite-other/main.cjs", "/.vite/renderer/private.json"]) {
      expect(ignore(path), path).toBe(true);
    }
  });
});
