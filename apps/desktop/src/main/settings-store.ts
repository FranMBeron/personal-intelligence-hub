import { chmod, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DesktopSettings } from "../shared/contracts.js";
import { normalizeServerOrigin } from "./server-origin.js";

const defaults = (): DesktopSettings => ({ serverOrigin: null, launchAtLogin: false });

export class SettingsStore {
  private readonly settingsPath: string;
  private readonly temporaryPath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    directory: string,
    private readonly options: { allowInsecureLoopback: boolean } = { allowInsecureLoopback: false },
  ) {
    this.settingsPath = join(directory, "settings.json");
    this.temporaryPath = join(directory, "settings.json.tmp");
  }

  private validate(value: unknown): DesktopSettings {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Invalid desktop settings");
    }
    const { serverOrigin, launchAtLogin } = value as Record<string, unknown>;
    if ((serverOrigin !== null && typeof serverOrigin !== "string") || typeof launchAtLogin !== "boolean") {
      throw new Error("Invalid desktop settings");
    }
    try {
      return {
        serverOrigin: serverOrigin === null ? null : normalizeServerOrigin(serverOrigin, this.options).origin,
        launchAtLogin,
      };
    } catch {
      throw new Error("Invalid desktop settings");
    }
  }

  async read(): Promise<DesktopSettings> {
    let raw: string;
    try {
      raw = await readFile(this.settingsPath, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return defaults();
      }
      throw new Error("Unable to read desktop settings");
    }
    try {
      return this.validate(JSON.parse(raw));
    } catch {
      return defaults();
    }
  }

  async write(settings: DesktopSettings): Promise<void> {
    const validated = this.validate(settings);
    const write = this.pendingWrite.then(async () => {
      try {
        const temporaryFile = await open(this.temporaryPath, "w", 0o600);
        try {
          await temporaryFile.chmod(0o600);
          await writeFile(temporaryFile, JSON.stringify(validated), { mode: 0o600 });
        } finally {
          await temporaryFile.close();
        }
        await rename(this.temporaryPath, this.settingsPath);
        await chmod(this.settingsPath, 0o600);
      } catch {
        await rm(this.temporaryPath, { force: true }).catch(() => undefined);
        throw new Error("Unable to write desktop settings");
      }
    });
    this.pendingWrite = write.catch(() => undefined);
    await write;
  }
}
