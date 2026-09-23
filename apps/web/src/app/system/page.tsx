import type { HermesCapabilities } from "@personal-intelligence-hub/contracts";
import { headers } from "next/headers";

import { PageHeader } from "../_components/app-shell";
import { Conversation } from "../_components/conversation/conversation";
import { SourceState } from "../_components/source-state";
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
  className,
}: Readonly<{
  title: string;
  description: string;
  status: Availability;
  children?: React.ReactNode;
  className?: string;
}>) {
  const presentation = statusPresentation[status];
  return (
    <article className={`system-source surface${className === undefined ? "" : ` ${className}`}`}>
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
  const aggregateHealthy = pihStatus === "available" && hermesStatus === "available";

  return (
    <div className="system-page">
      <PageHeader
        title="Sistema"
        description="Salud, seguridad y actividad verificable de tu infraestructura."
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

      <section className="system-health" aria-labelledby="system-health-title">
        <span className="system-health__icon" aria-hidden="true">✓</span>
        <div>
          <h2 id="system-health-title">
            {aggregateHealthy ? "Fuentes principales disponibles" : "Integraciones con atención pendiente"}
          </h2>
          <p>
            {aggregateHealthy
              ? "PIH API y Hermes respondieron a la última comprobación."
              : "El panel conserva únicamente los estados que cada fuente pudo verificar."}
          </p>
        </div>
        <span className="system-health__attention">Calendar no configurado</span>
      </section>

      <div className="system-metrics">
        <SourceCard
          title="PIH API"
          description="Datos personales, tableros, tareas, auditoría y snapshots."
          status={pihStatus}
          className="system-metric"
        />
        <SourceCard
          title="Hermes"
          description={
            hermesStatus === "not_configured"
              ? "Configura Hermes para habilitar conversación y agentes."
              : "Conversación, agentes y capacidades declaradas por el servicio."
          }
          status={hermesStatus}
          className="system-metric"
        />
        <SourceCard
          title="Calendar"
          description="La integración de calendario está prevista para la Etapa 5 y aún no forma parte del runtime."
          status="not_configured"
          className="system-metric"
        />
      </div>

      <div className="system-main-grid">
        <div className="system-main-column">
          <section className="system-observability panel" aria-labelledby="observability-title">
            <header className="panel-heading">
              <h2 id="observability-title">Observabilidad operativa</h2>
              <span className="panel-count">Etapa 6</span>
            </header>
            <SourceState
              compact
              state="not_configured"
              title="Métricas detalladas no conectadas"
              detail="Recursos, tendencias, seguridad, almacenamiento y copias aparecerán cuando una fuente verificable los publique."
            />
            <div className="system-placeholder-grid" aria-hidden="true">
              <span /><span /><span /><span />
            </div>
          </section>

          <section className="system-checks panel" aria-labelledby="checks-title">
            <header className="panel-heading">
              <h2 id="checks-title">Comprobación reciente</h2>
              <time className="panel-count" dateTime={checkedAt}>Ahora</time>
            </header>
            <div className="system-check-list">
              <span><i data-state={pihStatus} />PIH API consultada</span>
              <span><i data-state={hermesStatus} />Hermes consultado</span>
              <span><i data-state="not_configured" />Calendar pendiente de configuración</span>
            </div>
          </section>
        </div>

        <div className="system-side-column">
          <section className="system-services panel" aria-labelledby="services-title">
            <header className="panel-heading">
              <h2 id="services-title">Servicios y capacidades</h2>
              <span className="panel-count">Estado real</span>
            </header>
            <div className="service-list">
              <article><strong>PIH API</strong><span data-state={pihStatus}>{pihStatus === "available" ? "Conectada" : "Sin respuesta"}</span></article>
              <article><strong>Hermes</strong><span data-state={hermesStatus}>{hermesStatus === "available" ? "Conectado" : hermesStatus === "not_configured" ? "Pendiente" : "Sin respuesta"}</span></article>
              <article><strong>Calendar</strong><span data-state="not_configured">Pendiente</span></article>
            </div>
            {hermesStatus === "available" && hermesCapabilities !== null ? (
              <ul className="capability-list" aria-label="Capacidades de Hermes">
                {capabilityItems(hermesCapabilities).map((item) => <li key={item}>{item}</li>)}
              </ul>
            ) : null}
          </section>

          <section className="system-roadmap panel">
            <h2>Próxima capa de información</h2>
            <p>La observabilidad operativa detallada se incorporará en la Etapa 6; hasta entonces esta vista muestra únicamente estados que cada fuente puede verificar.</p>
          </section>
        </div>
      </div>

      <div className="system-conversation">
        <Conversation
          capabilities={hermesStatus === "available" ? hermesCapabilities : null}
          unavailableState={hermesStatus === "not_configured" ? "not_configured" : "unavailable"}
        />
      </div>
    </div>
  );
}
