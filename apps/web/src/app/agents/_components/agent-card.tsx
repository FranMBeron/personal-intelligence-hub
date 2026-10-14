import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";

import { StatusBadge } from "../../_components/status-badge";
import { AgentConversation } from "./agent-conversation";

type Tone = "positive" | "accent" | "warning" | "danger" | "neutral";
type Label = Readonly<{ label: string; tone: Tone }>;

const unknown: Label = { label: "Desconocido", tone: "neutral" };

const availability: Readonly<Record<AgentSummary["availability"], Label>> = {
  online: { label: "Disponible", tone: "positive" },
  offline: { label: "Sin conexión", tone: "danger" },
  unknown,
};

const execution: Readonly<Record<AgentSummary["execution"], Label>> = {
  idle: { label: "Inactivo", tone: "neutral" },
  working: { label: "Trabajando", tone: "accent" },
  waiting: { label: "En espera", tone: "warning" },
  unknown,
};

const result: Readonly<Record<AgentSummary["result"], Label>> = {
  none: { label: "Sin resultado", tone: "neutral" },
  ready: { label: "Resultado listo", tone: "positive" },
  unknown,
};

const attention: Readonly<Record<AgentSummary["attention"], Label>> = {
  none: { label: "Sin alertas", tone: "neutral" },
  required: { label: "Requiere atención", tone: "danger" },
  unknown,
};

const checkedFormat = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export const formatCheckedAt = (checkedAt: string): string => `${checkedFormat.format(new Date(checkedAt))} UTC`;

export function AgentCard({
  agent,
  capabilities,
}: Readonly<{
  agent: AgentSummary;
  capabilities: HermesCapabilities | null;
}>) {
  const presence = availability[agent.availability];
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
        <StatusBadge tone={presence.tone}>{presence.label}</StatusBadge>
      </header>
      <dl className="agent-card__details">
        <div><dt>Ejecución</dt><dd><StatusBadge tone={execution[agent.execution].tone}>{execution[agent.execution].label}</StatusBadge></dd></div>
        <div><dt>Resultado</dt><dd><StatusBadge tone={result[agent.result].tone}>{result[agent.result].label}</StatusBadge></dd></div>
        <div><dt>Atención</dt><dd><StatusBadge tone={attention[agent.attention].tone}>{attention[agent.attention].label}</StatusBadge></dd></div>
        <div><dt>Comprobado</dt><dd><time dateTime={agent.checkedAt}>{formatCheckedAt(agent.checkedAt)}</time></dd></div>
      </dl>
      <AgentConversation
        agentId={agent.id}
        agentName={agent.displayName}
        capabilities={capabilities}
      />
    </article>
  );
}
