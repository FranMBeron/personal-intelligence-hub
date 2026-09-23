import type { HermesCapabilities, Snapshot, Task } from "@personal-intelligence-hub/contracts";
import { headers } from "next/headers";

import { Conversation } from "./_components/conversation/conversation";
import { SourceState } from "./_components/source-state";
import { StatusBadge } from "./_components/status-badge";
import { buildHoyView } from "./_lib/hoy";
import { deriveRequestContext } from "../server/context";
import { serverRuntime } from "../server/runtime";

export const dynamic = "force-dynamic";

type Result<T> = { ok: true; value: T } | { ok: false };

const safely = async <T,>(operation: Promise<T>): Promise<Result<T>> => {
  try {
    return { ok: true, value: await operation };
  } catch {
    return { ok: false };
  }
};

const priorityLabel: Record<Task["priority"], string> = {
  critical: "Crítica",
  high: "Alta",
  normal: "Normal",
  low: "Baja",
};

export default async function HomePage() {
  const requestContext = deriveRequestContext(await headers());
  const snapshotPromise: Promise<Result<Snapshot>> = requestContext.ok
    ? safely(serverRuntime.personalData.snapshot(requestContext.context))
    : Promise.resolve({ ok: false });
  const capabilitiesPromise: Promise<Result<HermesCapabilities>> =
    requestContext.ok && serverRuntime.hermes !== null
      ? safely(serverRuntime.hermes.capabilities(requestContext.context))
      : Promise.resolve({ ok: false });
  const [snapshotResult, capabilitiesResult] = await Promise.all([
    snapshotPromise,
    capabilitiesPromise,
  ]);
  const view = snapshotResult.ok
    ? buildHoyView(snapshotResult.value, new Date())
    : null;

  return (
    <div className="hoy-page">
      <section className="hoy-hero" aria-labelledby="hoy-title">
        <div className="hoy-hero__copy">
          <p className="eyebrow">{view?.dateLabel ?? "Hoy"}</p>
          <h1 id="hoy-title">{view?.greeting ?? "Tu día, en contexto"}</h1>
          <p>
            {view === null
              ? "Las fuentes de tu día no están disponibles en este momento."
              : view.activePriorityCount === 0
                ? "No tenés prioridades activas registradas para hoy."
                : `Tenés ${view.activePriorityCount} ${view.activePriorityCount === 1 ? "prioridad activa" : "prioridades activas"} para hoy.`}
          </p>
        </div>
        <div className="hoy-hero__next">
          <p className="eyebrow">Próximo evento</p>
          <strong>Agenda todavía sin conectar</strong>
          <span>La agenda se conectará en la Etapa 5.</span>
          <StatusBadge tone={snapshotResult.ok ? "positive" : "warning"}>
            {snapshotResult.ok ? "Datos actualizados" : "Datos no disponibles"}
          </StatusBadge>
          {view === null ? null : (
            <time dateTime={view.generatedAt}>
              Lectura de {new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" }).format(new Date(view.generatedAt))}
            </time>
          )}
        </div>
      </section>

      <div className="day-grid">
        <section className="priority-panel panel" aria-labelledby="priorities-title">
          <header className="panel-heading">
            <h2 id="priorities-title">Prioridades de hoy</h2>
            <span className="panel-count">
              {view?.activePriorityCount ?? 0} {view?.activePriorityCount === 1 ? "activa" : "activas"}
            </span>
          </header>
          {view === null ? (
            <SourceState compact state="unavailable" title="Prioridades no disponibles" detail="La API de datos personales no respondió. No se muestran tareas inventadas." />
          ) : view.priorities.length === 0 ? (
            <SourceState compact state="empty" title="No hay prioridades registradas" detail="Este espacio se completará cuando existan tareas reales." />
          ) : (
            <ol className="priority-list">
              {view.priorities.map((task) => (
                <li className="priority-item" key={task.id} data-status={task.status}>
                  <span className="priority-item__marker" aria-hidden="true" />
                  <div>
                    <h3>{task.title}</h3>
                    <p>
                      {task.dueAt === null ? "Sin fecha límite" : new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(task.dueAt))}
                    </p>
                  </div>
                  <span className={`priority priority--${task.priority}`}>
                    {priorityLabel[task.priority]}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="panel-hint">Pedile a Hermes que complete, mueva o reordene una prioridad.</p>
        </section>

        <section className="agenda-panel panel" aria-labelledby="agenda-title">
          <header className="panel-heading">
            <h2 id="agenda-title">Línea de tiempo</h2>
            <span className="panel-count">Google Calendar</span>
          </header>
          <div className="agenda-track" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <SourceState compact state="not_configured" title="Calendario no configurado" detail="La agenda se activará en la Etapa 5. Hasta entonces no mostramos eventos de ejemplo." />
        </section>
      </div>

      <div className="hoy-conversation">
        <Conversation
          capabilities={capabilitiesResult.ok ? capabilitiesResult.value : null}
          unavailableState={serverRuntime.hermes === null ? "not_configured" : "unavailable"}
        />
      </div>
    </div>
  );
}
