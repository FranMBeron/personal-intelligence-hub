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
  const requestContext = deriveRequestContext(await headers());
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

  return (
    <div className="agents-page">
      <PageHeader
        eyebrow="Hermes"
        title="Agentes"
        description="Estado operativo y conversaciones contextuales. La configuración permanece en Hermes Dashboard."
        aside={serverRuntime.hermesDashboardUrl === undefined ? undefined : (
          <a className="button button--quiet" href={serverRuntime.hermesDashboardUrl} target="_blank" rel="noreferrer">
            Administrar en Hermes <Icon name="arrow-up-right" />
          </a>
        )}
      />

      {gateway === null ? (
        <SourceState state="not_configured" title="Hermes no configurado" detail="Configura el adaptador del servidor para consultar el roster." />
      ) : !agentsResult.ok ? (
        <SourceState state="unavailable" title="Roster no disponible" detail="Hermes está configurado, pero el roster no respondió." />
      ) : agentsResult.value.length === 0 ? (
        <SourceState state="empty" title="No hay agentes publicados" detail="Hermes respondió correctamente sin agentes visibles." />
      ) : (
        <div className="agent-grid">
          {agentsResult.value.map((agent) => (
            <AgentCard
              agent={agent}
              capabilities={capabilitiesResult.ok ? capabilitiesResult.value : null}
              key={agent.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
