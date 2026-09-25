import { describe, expect, it } from "vitest";

import nextConfig, { buildContentSecurityPolicy } from "../next.config";

describe("Next.js production security", () => {
  it("applies the browser security policy to every route", async () => {
    const rules = await nextConfig.headers?.();
    const globalRule = rules?.find((rule) => rule.source === "/:path*");
    const headers = new Headers(
      globalRule?.headers.map(({ key, value }) => [key, value]),
    );

    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.output).toBe("standalone");
    expect(headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("strict-transport-security")).toBeNull();
  });

  it("allows webpack evaluation only outside the production CSP", () => {
    expect(buildContentSecurityPolicy(true)).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy(false)).not.toContain("'unsafe-eval'");
  });
});
