import { HermesEventSchema, type HermesEvent } from "@personal-intelligence-hub/contracts";

type Options = Readonly<{
  conversationId: string;
  signal: AbortSignal;
  onEvent: (event: HermesEvent) => void;
  onUnavailable?: () => void;
  /** 401/403: the stream stops permanently; falls back to onUnavailable when omitted. */
  onAccessDenied?: () => void;
  onCursorExpired?: () => void | Promise<void>;
  initialCursor?: string | null;
  fetcher?: typeof fetch;
}>;

export const reconnectDelay = (attempt: number): number =>
  Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000);

export const waitForReconnect = (signal: AbortSignal, delay: number): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });

const readEvents = async (
  response: Response,
  onEvent: (event: HermesEvent) => void,
  onCursor: (cursor: string) => void,
  signal: AbortSignal,
): Promise<void> => {
  if (response.body === null) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const lines = block.split(/\r?\n/u);
        const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /u, ""))
          .join("\n");
        if (data === "") continue;
        const event = HermesEventSchema.parse(JSON.parse(data));
        if (id !== undefined && id !== event.id) continue;
        onEvent(event);
        onCursor(event.id);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader may already have released its lock.
    }
  }
};

export const subscribeToConversationEvents = async ({
  conversationId,
  signal,
  onEvent,
  onUnavailable,
  onAccessDenied,
  onCursorExpired,
  initialCursor,
  fetcher = fetch,
}: Options): Promise<void> => {
  let lastEventId = initialCursor ?? undefined;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const headers = new Headers({ accept: "text/event-stream" });
      if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
      const response = await fetcher(
        `/api/ui/v1/conversations/${encodeURIComponent(conversationId)}/events`,
        { cache: "no-store", credentials: "same-origin", headers, signal },
      );
      if (response.status === 410) {
        try {
          await onCursorExpired?.();
        } catch {
          onUnavailable?.();
        }
        return;
      }
      if (response.status === 401 || response.status === 403) {
        (onAccessDenied ?? onUnavailable)?.();
        return;
      }
      if (!response.ok) throw new Error("Conversation event stream unavailable.");
      await readEvents(response, onEvent, (cursor) => {
        lastEventId = cursor;
        failures = 0;
      }, signal);
      if (signal.aborted) return;
      failures += 1;
      onUnavailable?.();
    } catch {
      if (signal.aborted) return;
      failures += 1;
      onUnavailable?.();
    }
    await waitForReconnect(signal, reconnectDelay(failures - 1));
  }
};
