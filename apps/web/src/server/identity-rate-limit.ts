import "server-only";

export class IdentityRateLimitError extends Error {
  constructor() {
    super("The configured per-identity request limit was reached.");
    this.name = "IdentityRateLimitError";
  }
}

type Entry = { count: number; resetsAt: number };

export class IdentityRateLimiter {
  readonly #entries = new Map<string, Entry>();
  readonly #maximum: number;
  readonly #windowMs: number;
  readonly #clock: () => number;

  constructor({
    maximum,
    windowMs = 60_000,
    clock = Date.now,
  }: Readonly<{
    maximum: number;
    windowMs?: number;
    clock?: () => number;
  }>) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error("Identity request limit must be a positive integer.");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error("Identity request window must be a positive integer.");
    }
    this.#maximum = maximum;
    this.#windowMs = windowMs;
    this.#clock = clock;
  }

  consume(identity: string): void {
    const now = this.#clock();
    const current = this.#entries.get(identity);
    if (current === undefined || current.resetsAt <= now) {
      this.#entries.set(identity, { count: 1, resetsAt: now + this.#windowMs });
      return;
    }
    if (current.count >= this.#maximum) throw new IdentityRateLimitError();
    current.count += 1;
  }
}
