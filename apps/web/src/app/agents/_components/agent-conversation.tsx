"use client";

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { useState } from "react";

import { ThreadWorkspace } from "../../_components/conversation/thread-workspace";

export const unavailableNote = (capabilities: HermesCapabilities | null): string | null =>
  capabilities === null
    ? "La conversación no está disponible ahora."
    : capabilities.agentConversations
      ? null
      : "Las conversaciones por agente no están habilitadas.";

/** Direct, persistent threads with one profile. Never lists delegations. */
export function DirectConversations({
  agentId,
  agentName,
  capabilities,
}: Readonly<{
  agentId: string;
  agentName: string;
  capabilities: HermesCapabilities | null;
}>) {
  const note = unavailableNote(capabilities);
  if (note !== null) return <p className="agent-card__conversation-note">{note}</p>;
  return <ThreadWorkspace key={agentId} agentId={agentId} agentName={agentName} capabilities={capabilities} />;
}

/** Inline toggle kept for the current page until the roster section is mounted. */
export function AgentConversation({
  agentId,
  agentName,
  capabilities,
}: Readonly<{
  agentId: string;
  agentName: string;
  capabilities: HermesCapabilities | null;
}>) {
  const [open, setOpen] = useState(false);
  const note = unavailableNote(capabilities);
  if (note !== null) return <p className="agent-card__conversation-note">{note}</p>;

  return (
    <div className="agent-conversation">
      <button
        className="button button--quiet"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Cerrar conversación" : `Conversar con ${agentName}`}
      </button>
      {open ? (
        <div className="agent-conversation__panel">
          <DirectConversations agentId={agentId} agentName={agentName} capabilities={capabilities} />
        </div>
      ) : null}
    </div>
  );
}
