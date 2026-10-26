import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";

import { StatusBadge } from "../../_components/status-badge";
import { formatAgentTime } from "../_lib/agents-view";
import { AgentConversation, unavailableNote } from "./agent-conversation";

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

export function AgentCard({
  agent,
  capabilities,
  headingLevel = 2,
  selected = false,
  onOpen,
  timeZone = null,
}: Readonly<{
  agent: AgentSummary;
  capabilities: HermesCapabilities | null;
  headingLevel?: 2 | 3;
  selected?: boolean;
  /** When provided, the card only selects the profile; the workspace renders outside the card. */
  onOpen?: (agentId: string) => void;
  /** User's preferred IANA zone; `null` renders explicit UTC. */
  timeZone?: string | null;
}>) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const presence = availability[agent.availability];
  const conversationNote = unavailableNote(capabilities);
  const initials = agent.displayName
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <article className="agent-card surface" data-selected={selected ? "true" : undefined}>
      <header className="agent-card__header">
        <span className="agent-card__avatar" aria-hidden="true">{initials}</span>
        <div>
          <Heading>{agent.displayName}</Heading>
          <p className="agent-card__id">{agent.id}</p>
        </div>
        <StatusBadge tone={presence.tone}>{presence.label}</StatusBadge>
      </header>
      <dl className="agent-card__details">
        <div><dt>Ejecución</dt><dd><StatusBadge tone={execution[agent.execution].tone}>{execution[agent.execution].label}</StatusBadge></dd></div>
        <div><dt>Resultado</dt><dd><StatusBadge tone={result[agent.result].tone}>{result[agent.result].label}</StatusBadge></dd></div>
        <div><dt>Atención</dt><dd><StatusBadge tone={attention[agent.attention].tone}>{attention[agent.attention].label}</StatusBadge></dd></div>
        <div><dt>Comprobado</dt><dd><time dateTime={agent.checkedAt}>{formatAgentTime(agent.checkedAt, timeZone)}</time></dd></div>
      </dl>
      {onOpen === undefined ? (
        <AgentConversation
          agentId={agent.id}
          agentName={agent.displayName}
          capabilities={capabilities}
        />
      ) : conversationNote !== null ? (
        // Without direct conversations the workspace still opens, read-only, for the delegation ledger.
        <div className="agent-conversation">
          <p className="agent-card__conversation-note">{conversationNote}</p>
          <button
            className="button button--quiet"
            type="button"
            aria-pressed={selected}
            data-agent-open={agent.id}
            onClick={() => onOpen(agent.id)}
          >
            {`Ver delegaciones de ${agent.displayName}`}
          </button>
        </div>
      ) : (
        <div className="agent-conversation">
          <button
            className="button button--quiet"
            type="button"
            aria-pressed={selected}
            data-agent-open={agent.id}
            onClick={() => onOpen(agent.id)}
          >
            {`Conversar con ${agent.displayName}`}
          </button>
        </div>
      )}
    </article>
  );
}
