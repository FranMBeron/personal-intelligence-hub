import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const configFile = join(desktopRoot, "vite.renderer.config.ts");

describe("renderer content security policy", () => {
  it("serves development HMR without an intersecting production meta policy", async () => {
    const server = await createServer({
      configFile, root: join(desktopRoot, "src/renderer"),
      server: { host: "127.0.0.1", port: 0 },
    });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server");
      const response = await fetch("http://127.0.0.1:" + address.port);
      const html = await response.text();
      expect(html).toContain("/@vite/client");
      expect(html).not.toMatch(/http-equiv=["']Content-Security-Policy/i);
      const csp = response.headers.get("content-security-policy");
      expect(csp).toContain("connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-eval");
    } finally {
      await server.close();
    }
  });

  it("builds a strict production meta policy with relative local assets", async () => {
    const output = await mkdtemp(join(tmpdir(), "desktop-csp-"));
    try {
      await build({
        configFile, root: join(desktopRoot, "src/renderer"), logLevel: "silent",
        build: { outDir: output, emptyOutDir: true },
      });
      const html = await readFile(join(output, "index.html"), "utf8");
      expect(html).toMatch(/http-equiv=["']Content-Security-Policy/i);
      expect(html).toContain("default-src 'none'; script-src 'self'; style-src 'self'");
      expect(html).not.toMatch(/unsafe-inline|unsafe-eval|ws:\/\/|https?:\/\//);
      expect(html).toMatch(/src="\.\/assets\/[^"]+\.js"/);
      expect(html).toMatch(/href="\.\/assets\/[^"]+\.css"/);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
