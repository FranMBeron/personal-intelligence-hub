import "server-only";

export class IdentityConcurrencyLimitError extends Error {
  constructor() {
    super("The configured per-identity concurrency limit was reached.");
    this.name = "IdentityConcurrencyLimitError";
  }
}

export class IdentityConcurrencyLimiter {
  readonly #active = new Map<string, number>();

  constructor(readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error("Identity concurrency must be a positive integer.");
    }
  }

  async run<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const active = this.#active.get(identity) ?? 0;
    if (active >= this.maximum) {
      throw new IdentityConcurrencyLimitError();
    }
    this.#active.set(identity, active + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.#active.get(identity) ?? 1) - 1;
      if (remaining === 0) this.#active.delete(identity);
      else this.#active.set(identity, remaining);
    }
  }
}
