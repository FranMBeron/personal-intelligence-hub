import { HermesEventSchema, type HermesEvent } from "@personal-intelligence-hub/contracts";

type Options = Readonly<{
  conversationId: string;
  signal: AbortSignal;
  onEvent: (event: HermesEvent) => void;
  onUnavailable?: () => void;
  fetcher?: typeof fetch;
}>;

const waitForReconnect = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 1_000);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });

const readEvents = async (
  response: Response,
  onEvent: (event: HermesEvent) => void,
): Promise<string | undefined> => {
  if (response.body === null) return undefined;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let lastEventId: string | undefined;
  while (true) {
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
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data === "") continue;
      const event = HermesEventSchema.parse(JSON.parse(data));
      if (id !== undefined && id !== event.id) continue;
      lastEventId = event.id;
      onEvent(event);
    }
  }
  return lastEventId;
};

export const subscribeToConversationEvents = async ({
  conversationId,
  signal,
  onEvent,
  onUnavailable,
  fetcher = fetch,
}: Options): Promise<void> => {
  let lastEventId: string | undefined;
  while (!signal.aborted) {
    try {
      const headers = new Headers({ accept: "text/event-stream" });
      if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
      const response = await fetcher(
        `/api/ui/v1/conversations/${encodeURIComponent(conversationId)}/events`,
        { cache: "no-store", credentials: "same-origin", headers, signal },
      );
      if (!response.ok) throw new Error("Conversation event stream unavailable.");
      lastEventId = (await readEvents(response, onEvent)) ?? lastEventId;
    } catch {
      if (signal.aborted) return;
      onUnavailable?.();
    }
    await waitForReconnect(signal);
  }
};
