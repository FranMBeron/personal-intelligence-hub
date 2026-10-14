/** In-process FIFO mutex per key. Connectors run as a single replica while SQLite is used. */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.#tails.set(key, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    }
  }
}

export const proposalLockKey = (actorId: string, proposalId: string): string => `${actorId}\0${proposalId}`;
