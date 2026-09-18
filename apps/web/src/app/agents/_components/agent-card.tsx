import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";

import { StatusBadge } from "../../_components/status-badge";
import { AgentConversation } from "./agent-conversation";

const statuses: Record<
  AgentSummary["status"],
  { label: string; tone: "positive" | "accent" | "warning" | "danger" | "neutral" }
> = {
  available: { label: "Disponible", tone: "positive" },
  working: { label: "Trabajando", tone: "accent" },
  waiting: { label: "En espera", tone: "warning" },
  offline: { label: "Sin conexión", tone: "danger" },
  unknown: { label: "Desconocido", tone: "neutral" },
};

export function AgentCard({
  agent,
  capabilities,
}: Readonly<{
  agent: AgentSummary;
  capabilities: HermesCapabilities | null;
}>) {
  const status = statuses[agent.status];
  const initials = agent.displayName
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <article className="agent-card surface">
      <header className="agent-card__header">
        <span className="agent-card__avatar" aria-hidden="true">{initials}</span>
        <div>
          <h2>{agent.displayName}</h2>
          <p className="agent-card__id">{agent.id}</p>
        </div>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </header>
      <dl className="agent-card__details">
        {agent.currentWork === undefined ? null : (
          <div><dt>Trabajo actual</dt><dd>{agent.currentWork}</dd></div>
        )}
        {agent.lastResult === undefined ? null : (
          <div><dt>Último resultado</dt><dd>{agent.lastResult}</dd></div>
        )}
        {agent.modelLabel === undefined ? null : (
          <div><dt>Modelo</dt><dd>{agent.modelLabel}</dd></div>
        )}
      </dl>
      <AgentConversation
        agentId={agent.id}
        agentName={agent.displayName}
        capabilities={capabilities}
      />
    </article>
  );
}
