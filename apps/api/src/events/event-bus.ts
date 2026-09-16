import type { OutboxEvent } from "@personal-intelligence-hub/contracts";

export type EventListener = (event: OutboxEvent) => void | Promise<void>;

export class EventBus {
  readonly #listeners = new Set<EventListener>();

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async publish(event: OutboxEvent): Promise<void> {
    await Promise.all([...this.#listeners].map(async (listener) => listener(event)));
  }
}
