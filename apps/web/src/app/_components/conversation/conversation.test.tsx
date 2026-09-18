// @vitest-environment jsdom

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Conversation } from "./conversation";

vi.mock("./event-stream", () => ({
  subscribeToConversationEvents: vi.fn(async () => undefined),
}));

const textOnly: HermesCapabilities = {
  text: true,
  streaming: false,
  voice: { enabled: false },
  attachments: { enabled: false },
  agentConversations: false,
};
const occurredAt = "2026-09-18T12:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Conversation", () => {
  it("explains disabled voice and attachment controls", () => {
    render(<Conversation capabilities={textOnly} />);

    expect(
      screen.getByRole("button", { name: "Añadir adjunto" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Añadir voz" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("Hermes no admite adjuntos en esta instalación.")).toBeTruthy();
    expect(screen.getByText("Hermes no admite voz en esta instalación.")).toBeTruthy();
  });

  it("creates a conversation lazily and sends text with one idempotency key", async () => {
    const randomUUID = vi.fn(() => "00000000-0000-4000-8000-000000000001");
    vi.stubGlobal("crypto", { randomUUID });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            id: "conversation-01",
            agentId: null,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "message-01",
          conversationId: "conversation-01",
          role: "user",
          parts: [{ kind: "text", text: "Resume mis prioridades" }],
          deliveryState: "accepted",
          createdAt: occurredAt,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    render(<Conversation capabilities={textOnly} />);

    fireEvent.change(screen.getByLabelText("Mensaje para Hermes"), {
      target: { value: "Resume mis prioridades" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Conversación con Hermes" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const conversationRequest = fetcher.mock.calls[0]?.[0] as Request;
    expect(conversationRequest.url).toContain("/api/ui/v1/conversations");
    const messageRequest = fetcher.mock.calls[1]?.[0] as Request;
    expect(messageRequest.headers.get("idempotency-key")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(randomUUID).toHaveBeenCalledTimes(2);
    expect(await messageRequest.json()).toEqual({
      parts: [{ kind: "text", text: "Resume mis prioridades" }],
    });
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Resume mis prioridades")).toBeTruthy();
  });
});
