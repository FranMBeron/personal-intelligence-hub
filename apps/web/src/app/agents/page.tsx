import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { headers } from "next/headers";

import { Icon } from "../_components/icon";
import { PageHeader } from "../_components/app-shell";
import { SourceState } from "../_components/source-state";
import { AgentCard } from "./_components/agent-card";
import { deriveRequestContext } from "../../server/context";
import { serverRuntime } from "../../server/runtime";

export const dynamic = "force-dynamic";

type Result<T> = { ok: true; value: T } | { ok: false };
const safely = async <T,>(operation: Promise<T>): Promise<Result<T>> => {
  try {
    return { ok: true, value: await operation };
  } catch {
    return { ok: false };
  }
};

export default async function AgentsPage() {
  const requestContext = await deriveRequestContext(
    await headers(),
    undefined,
    serverRuntime.identity,
  );
  const gateway = serverRuntime.hermes;
  const capabilitiesPromise: Promise<Result<HermesCapabilities>> =
    requestContext.ok && gateway !== null
      ? safely(gateway.capabilities(requestContext.context))
      : Promise.resolve({ ok: false });
  const agentsPromise: Promise<Result<readonly AgentSummary[]>> =
    requestContext.ok && gateway !== null
      ? safely(gateway.agents(requestContext.context))
      : Promise.resolve({ ok: false });
  const [capabilitiesResult, agentsResult] = await Promise.all([
    capabilitiesPromise,
    agentsPromise,
  ]);
  const agents = agentsResult.ok ? agentsResult.value : [];
  const availableCount = agents.filter(({ status }) => status === "available").length;
  const workingCount = agents.filter(({ status }) => status === "working").length;
  const readyCount = agents.filter(({ status }) => status === "waiting").length;
  const attentionCount = agents.filter(({ status }) =>
    status === "offline" || status === "unknown"
  ).length;
  const activity = agents.flatMap((agent) => {
    if (agent.currentWork !== undefined) {
      return [{ id: `${agent.id}-work`, name: agent.displayName, detail: `En curso · ${agent.currentWork}` }];
    }
    if (agent.lastResult !== undefined) {
      return [{ id: `${agent.id}-result`, name: agent.displayName, detail: `Resultado · ${agent.lastResult}` }];
    }
    return [];
  }).slice(0, 3);

  return (
    <div className="agents-page">
      <PageHeader
        title="Agentes"
        description="Estado, trabajo actual y acceso directo."
        aside={serverRuntime.hermesDashboardUrl === undefined ? undefined : (
          <a className="button button--quiet" href={serverRuntime.hermesDashboardUrl} target="_blank" rel="noreferrer">
            Administrar en Hermes <Icon name="arrow-up-right" />
          </a>
        )}
      />

      <div className="agent-filters" aria-label="Resumen del roster">
        <span className="filter-pill filter-pill--active">Todos</span>
        <span className="filter-pill">En actividad</span>
        <span className="filter-pill">Con alertas</span>
      </div>

      <section className="agent-summary" aria-label="Resumen de agentes">
        <article className="summary-metric"><span>Disponibles</span><strong>{availableCount}</strong><small>{availableCount === 1 ? "1 agente conectado" : `${availableCount} agentes conectados`}</small></article>
        <article className="summary-metric"><span>Trabajando ahora</span><strong>{workingCount}</strong><small>{workingCount === 0 ? "Sin trabajos publicados" : "Actividad en curso"}</small></article>
        <article className="summary-metric"><span>Resultados listos</span><strong>{readyCount}</strong><small>{readyCount === 0 ? "Sin resultados pendientes" : "Revisión disponible"}</small></article>
        <article className="summary-metric"><span>Requieren atención</span><strong>{attentionCount}</strong><small>{attentionCount === 0 ? "Sin bloqueos" : "Revisar estado"}</small></article>
      </section>

      <section className="agent-roster" aria-label="Roster de agentes">
        {gateway === null ? (
          <SourceState compact state="not_configured" title="Hermes no configurado" detail="Configura el adaptador del servidor para consultar el roster." />
        ) : !agentsResult.ok ? (
          <SourceState compact state="unavailable" title="Roster no disponible" detail="Hermes está configurado, pero el roster no respondió." />
        ) : agents.length === 0 ? (
          <SourceState compact state="empty" title="No hay agentes publicados" detail="Hermes respondió correctamente sin agentes visibles." />
        ) : (
          <div className="agent-grid">
            {agents.map((agent) => (
              <AgentCard
                agent={agent}
                capabilities={capabilitiesResult.ok ? capabilitiesResult.value : null}
                key={agent.id}
              />
            ))}
          </div>
        )}
      </section>

      <section className="agent-activity panel" aria-labelledby="agent-activity-title">
        <header className="panel-heading">
          <h2 id="agent-activity-title">Actividad reciente</h2>
          <span className="panel-count">Hermes</span>
        </header>
        {activity.length === 0 ? (
          <SourceState compact state="empty" title="Sin actividad publicada" detail="La actividad aparecerá cuando Hermes informe trabajo o resultados reales." />
        ) : (
          <div className="activity-feed">
            {activity.map((item) => (
              <article className="activity-item" key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.detail}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
