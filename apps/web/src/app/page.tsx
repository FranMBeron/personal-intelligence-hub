import type { HermesCapabilities, Snapshot, Task } from "@personal-intelligence-hub/contracts";
import { headers } from "next/headers";

import { PageHeader } from "./_components/app-shell";
import { Conversation } from "./_components/conversation/conversation";
import { Icon } from "./_components/icon";
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
      <PageHeader
        eyebrow={view?.dateLabel ?? "Hoy"}
        title={view?.greeting ?? "Tu día, en contexto"}
        description="Prioridades reales, fuentes explícitas y una conversación para actuar sin perder el hilo."
        aside={
          <div className="freshness">
            <StatusBadge tone={snapshotResult.ok ? "positive" : "warning"}>
              {snapshotResult.ok ? "Datos actualizados" : "Datos no disponibles"}
            </StatusBadge>
            {view === null ? null : (
              <time dateTime={view.generatedAt}>
                Lectura de {new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" }).format(new Date(view.generatedAt))}
              </time>
            )}
          </div>
        }
      />

      <div className="hoy-grid">
        <section className="priority-panel surface" aria-labelledby="priorities-title">
          <header className="section-heading">
            <div><p className="eyebrow">En foco</p><h2 id="priorities-title">Prioridades</h2></div>
            <span className="section-count">{view?.activePriorityCount ?? 0}</span>
          </header>
          {view === null ? (
            <SourceState state="unavailable" title="Prioridades no disponibles" detail="La API de datos personales no respondió. No se muestran tareas inventadas." />
          ) : view.priorities.length === 0 ? (
            <SourceState state="empty" title="No hay prioridades registradas" />
          ) : (
            <ol className="priority-list">
              {view.priorities.map((task) => (
                <li className="priority-item" key={task.id} data-status={task.status}>
                  <span className="priority-item__marker" aria-hidden="true" />
                  <div>
                    <h3>{task.title}</h3>
                    <p>
                      {priorityLabel[task.priority]}
                      {task.dueAt === null ? " · Sin fecha límite" : ` · ${new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(task.dueAt))}`}
                    </p>
                  </div>
                  <StatusBadge tone={task.status === "in_progress" ? "accent" : "neutral"}>
                    {task.status === "in_progress" ? "En curso" : task.status === "todo" ? "Pendiente" : task.status === "done" ? "Hecha" : "Cancelada"}
                  </StatusBadge>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="agenda-panel surface" aria-labelledby="agenda-title">
          <header className="section-heading">
            <div><p className="eyebrow">Agenda</p><h2 id="agenda-title">Siguiente</h2></div>
            <span className="agenda-panel__icon"><Icon name="calendar" /></span>
          </header>
          <SourceState state="not_configured" title="Calendario no configurado" detail="La agenda se activará en la Etapa 5. Hasta entonces no mostramos eventos de ejemplo." />
        </section>

        <div className="hoy-conversation">
          <Conversation
            capabilities={capabilitiesResult.ok ? capabilitiesResult.value : null}
            unavailableState={serverRuntime.hermes === null ? "not_configured" : "unavailable"}
          />
        </div>
      </div>
    </div>
  );
}
