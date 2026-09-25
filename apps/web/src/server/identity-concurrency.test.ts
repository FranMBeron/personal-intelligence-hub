// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  IdentityConcurrencyLimitError,
  IdentityConcurrencyLimiter,
} from "./identity-concurrency";

describe("identity concurrency limiter", () => {
  it("rejects excess work for one identity without blocking another", async () => {
    const limiter = new IdentityConcurrencyLimiter(1);
    let finish!: () => void;
    const first = limiter.run(
      "identity-a",
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));

    await expect(
      limiter.run("identity-a", async () => "not-run"),
    ).rejects.toBeInstanceOf(IdentityConcurrencyLimitError);
    await expect(
      limiter.run("identity-b", async () => "allowed"),
    ).resolves.toBe("allowed");

    finish();
    await first;
    await expect(
      limiter.run("identity-a", async () => "released"),
    ).resolves.toBe("released");
  });

  it("validates the configured concurrency bound", () => {
    expect(() => new IdentityConcurrencyLimiter(0)).toThrow();
    expect(() => new IdentityConcurrencyLimiter(1.5)).toThrow();
  });
});
