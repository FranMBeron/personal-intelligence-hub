import type { AgentSummary, HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { headers } from "next/headers";

import { Icon } from "../_components/icon";
import { PageHeader } from "../_components/app-shell";
import { SourceState } from "../_components/source-state";
import { AgentCard, formatCheckedAt } from "./_components/agent-card";
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
  const count = (matches: (agent: AgentSummary) => boolean): number | null =>
    agentsResult.ok ? agents.filter(matches).length : null;
  const availableCount = count(({ availability }) => availability === "online");
  const workingCount = count(({ execution }) => execution === "working");
  const readyCount = count(({ result }) => result === "ready");
  const attentionCount = count(({ attention }) => attention === "required");
  const activity = agents
    .filter(({ execution, result }) => execution === "working" || result === "ready")
    .toSorted((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt))
    .map((agent) => ({
      id: agent.id,
      name: agent.displayName,
      detail: agent.execution === "working" ? "En curso" : "Resultado listo",
      checkedAt: agent.checkedAt,
    }));
  const summary = (value: number | null, none: string, some: (value: number) => string) => ({
    value: value === null ? "Sin datos" : String(value),
    detail: value === null ? "Estado no disponible" : value === 0 ? none : some(value),
  });
  const metrics = [
    { label: "Disponibles", ...summary(availableCount, "Ningún agente conectado", (value) => value === 1 ? "1 agente conectado" : `${value} agentes conectados`) },
    { label: "Trabajando ahora", ...summary(workingCount, "Sin trabajos publicados", () => "Actividad en curso") },
    { label: "Resultados listos", ...summary(readyCount, "Sin resultados pendientes", () => "Revisión disponible") },
    { label: "Requieren atención", ...summary(attentionCount, "Sin bloqueos", () => "Revisar estado") },
  ];

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
        {metrics.map((metric) => (
          <article className="summary-metric" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.detail}</small></article>
        ))}
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
                <time dateTime={item.checkedAt}>{formatCheckedAt(item.checkedAt)}</time>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
