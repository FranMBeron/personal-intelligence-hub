// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  IdentityRateLimitError,
  IdentityRateLimiter,
} from "./identity-rate-limit";

describe("identity loop limiter", () => {
  it("bounds one identity within a window without affecting another", () => {
    let now = 1_000;
    const limiter = new IdentityRateLimiter({
      maximum: 2,
      windowMs: 60_000,
      clock: () => now,
    });

    limiter.consume("identity-a");
    limiter.consume("identity-a");
    expect(() => limiter.consume("identity-a")).toThrow(IdentityRateLimitError);
    expect(() => limiter.consume("identity-b")).not.toThrow();

    now += 60_000;
    expect(() => limiter.consume("identity-a")).not.toThrow();
  });

  it("validates the configured bound and window", () => {
    expect(() => new IdentityRateLimiter({ maximum: 0 })).toThrow();
    expect(() => new IdentityRateLimiter({ maximum: 1, windowMs: 0 })).toThrow();
  });
});
