"use client";

import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { useId, useMemo } from "react";

import { SourceState } from "../../_components/source-state";
import {
  AGENT_FILTERS,
  buildAgentsView,
  filterAgents,
  parseAgentFilter,
  type RosterResult,
} from "../_lib/agents-view";
import { useQueryParam } from "../_lib/use-query-param";
import { AgentCard } from "./agent-card";
import "./agents.css";

/**
 * Metrics, filter bar and roster. Filter and selected profile live in the
 * URL query (`filter`, `agent`) so back/forward restore them; this component
 * never owns chat state and never starts a conversation.
 */
export function AgentRoster({
  result,
  capabilities,
}: Readonly<{
  result: RosterResult;
  capabilities: HermesCapabilities | null;
}>) {
  const view = useMemo(() => buildAgentsView(result), [result]);
  const [rawFilter, setFilter] = useQueryParam("filter");
  const [selectedId, setSelectedId] = useQueryParam("agent");
  const filter = parseAgentFilter(rawFilter);
  const visible = filterAgents(view.agents, filter);
  const filtersId = useId();
  const available = view.state === "available";

  let roster;
  if (view.state === "not_configured") {
    roster = <SourceState compact state="not_configured" title="Hermes no configurado" detail="Configura el adaptador del servidor para consultar el roster." />;
  } else if (view.state === "unavailable") {
    roster = <SourceState compact state="unavailable" title="Roster no disponible" detail="Hermes está configurado, pero el roster no respondió." />;
  } else if (view.agents.length === 0) {
    roster = <SourceState compact state="empty" title="No hay agentes publicados" detail="Hermes respondió correctamente sin agentes visibles." />;
  } else if (visible.length === 0) {
    roster = <SourceState compact state="empty" title="Ningún agente coincide con este filtro" detail="Elige «Todos» para ver el roster completo." />;
  } else {
    roster = (
      <ul className="agents-roster__list">
        {visible.map((agent) => (
          <li className="agents-roster__item" key={agent.id}>
            <AgentCard
              agent={agent}
              capabilities={capabilities}
              headingLevel={3}
              selected={selectedId === agent.id}
              onOpen={(agentId) => setSelectedId(selectedId === agentId ? null : agentId)}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="agents-roster">
      <section className="agents-roster__metrics" aria-label="Resumen de agentes">
        {view.metrics.map((metric) => (
          <article className="agents-roster__metric" data-tone={metric.tone} key={metric.id}>
            <span className="agents-roster__metric-label">{metric.label}</span>
            <strong className="agents-roster__metric-value">{metric.value}</strong>
            <small className="agents-roster__metric-detail">{metric.detail}</small>
          </article>
        ))}
      </section>

      <div className="agents-roster__filters" role="group" aria-label="Filtrar agentes" id={filtersId}>
        {AGENT_FILTERS.map((option) => (
          <button
            className="agents-roster__filter"
            type="button"
            key={option.id}
            aria-pressed={filter === option.id}
            disabled={!available}
            onClick={() => setFilter(option.id === "all" ? null : option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <section className="agents-roster__roster" aria-label="Roster de agentes">
        {roster}
        {available && view.agents.length > 0 ? (
          <p className="sr-only" role="status">{`Mostrando ${visible.length} de ${view.agents.length} agentes`}</p>
        ) : null}
      </section>
    </div>
  );
}
