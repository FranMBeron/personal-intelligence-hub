import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { headers } from "next/headers";

import { PageHeader } from "../_components/app-shell";
import { StatusBadge } from "../_components/status-badge";
import { deriveRequestContext } from "../../server/context";
import { serverRuntime } from "../../server/runtime";

export const dynamic = "force-dynamic";

type Availability = "available" | "unavailable" | "not_configured";

const statusPresentation: Record<
  Availability,
  Readonly<{ label: string; tone: "positive" | "danger" | "warning" }>
> = {
  available: { label: "Disponible", tone: "positive" },
  unavailable: { label: "No disponible", tone: "danger" },
  not_configured: { label: "No configurado", tone: "warning" },
};

function SourceCard({
  title,
  description,
  status,
  children,
}: Readonly<{
  title: string;
  description: string;
  status: Availability;
  children?: React.ReactNode;
}>) {
  const presentation = statusPresentation[status];
  return (
    <article className="system-source surface">
      <header>
        <div>
          <p className="eyebrow">Fuente</p>
          <h2>{title}</h2>
        </div>
        <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
      </header>
      <p className="system-source__description">{description}</p>
      {children}
    </article>
  );
}

const capabilityItems = (capabilities: HermesCapabilities): readonly string[] => [
  capabilities.text ? "Texto" : "Texto no disponible",
  capabilities.streaming ? "Streaming" : "Streaming no disponible",
  capabilities.attachments.enabled ? "Adjuntos" : "Adjuntos no disponibles",
  capabilities.voice.enabled ? "Voz" : "Voz no disponible",
  capabilities.agentConversations
    ? "Conversaciones por agente"
    : "Conversaciones por agente no disponibles",
];

export default async function SystemPage() {
  const checkedAt = new Date().toISOString();
  const requestContext = deriveRequestContext(await headers());
  const pihCheck = serverRuntime.personalData.health(
    requestContext.ok ? requestContext.context : undefined,
  );
  const hermesCheck =
    serverRuntime.hermes === null
      ? Promise.resolve<HermesCapabilities | null>(null)
      : requestContext.ok
        ? serverRuntime.hermes.capabilities(requestContext.context)
        : Promise.reject(new Error("Delegated request context unavailable."));
  const [pihResult, hermesResult] = await Promise.allSettled([pihCheck, hermesCheck]);
  const pihStatus: Availability =
    pihResult.status === "fulfilled" ? pihResult.value.status : "unavailable";
  const hermesStatus: Availability =
    serverRuntime.hermes === null
      ? "not_configured"
      : hermesResult.status === "fulfilled"
        ? "available"
        : "unavailable";
  const hermesCapabilities =
    hermesResult.status === "fulfilled" ? hermesResult.value : null;

  return (
    <div className="system-page">
      <PageHeader
        eyebrow="Operación"
        title="Sistema"
        description="Estado verificado de las fuentes que alimentan esta interfaz. No se infieren métricas que las APIs no publican."
        aside={(
          <div className="freshness">
            <span>Última comprobación</span>
            <time dateTime={checkedAt}>
              {new Intl.DateTimeFormat("es", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "UTC",
              }).format(new Date(checkedAt))} UTC
            </time>
          </div>
        )}
      />

      <div className="system-grid">
        <SourceCard
          title="PIH API"
          description="Datos personales, tableros, tareas, auditoría y snapshots."
          status={pihStatus}
        />
        <SourceCard
          title="Hermes"
          description={
            hermesStatus === "not_configured"
              ? "Configura Hermes para habilitar conversación y agentes."
              : "Conversación, agentes y capacidades declaradas por el servicio."
          }
          status={hermesStatus}
        >
          {hermesStatus === "available" && hermesCapabilities !== null ? (
            <ul className="capability-list" aria-label="Capacidades de Hermes">
              {capabilityItems(hermesCapabilities).map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}
        </SourceCard>
        <SourceCard
          title="Calendar"
          description="La integración de calendario está prevista para la Etapa 5 y aún no forma parte del runtime."
          status="not_configured"
        />
      </div>
      <p className="system-roadmap">
        La observabilidad operativa detallada se incorporará en la Etapa 6; hasta entonces esta vista muestra únicamente estados que cada fuente puede verificar.
      </p>
    </div>
  );
}
