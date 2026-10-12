"use client";

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { useState } from "react";

import { Conversation } from "../../_components/conversation/conversation";

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

  if (capabilities === null) {
    return <p className="agent-card__conversation-note">La conversación no está disponible ahora.</p>;
  }
  if (!capabilities.agentConversations) {
    return <p className="agent-card__conversation-note">Las conversaciones por agente no están habilitadas.</p>;
  }

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
          <Conversation capabilities={capabilities} agentId={agentId} />
        </div>
      ) : null}
    </div>
  );
}
