// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const privateSentinel = "http://private-api.example.test/never-serialize";
const secretSentinel = "private-secret-never-serialize";

describe("HomePage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders the product identity and a neutral API state without leaking private values", async () => {
    // This fails if the server-rendered shell loses its accessible status, product
    // identity, or accidentally includes server environment values in its output.
    vi.stubEnv("PIH_API_INTERNAL_URL", privateSentinel);
    vi.stubEnv("PIH_API_INTERNAL_SECRET", secretSentinel);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    const { default: HomePage } = await import("./page");

    const { container } = render(await HomePage());

    expect(screen.getByRole("heading", { name: "Personal Intelligence Hub" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "API status: unavailable",
    );
    expect(container.textContent).not.toContain(privateSentinel);
    expect(container.textContent).not.toContain(secretSentinel);
  });
});
