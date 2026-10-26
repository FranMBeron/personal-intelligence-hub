import type { Snapshot, Task } from "@personal-intelligence-hub/contracts";

import type { AgendaResult } from "../_lib/agenda";
import { buildDayHeading, buildHoyView, type HoyView, type TimeZoneResult } from "../_lib/hoy";
import type { Loadable } from "../system/_lib/system-view";
import { formatClock, formatInstant } from "../_lib/time-format";
import { AgendaPanel } from "./agenda";
import { SourceState } from "./source-state";

export type { HoyOperationalInputs, HoySources, TimeZoneResult } from "../_lib/hoy";
export { loadHoyOperational } from "../_lib/hoy";

const priorityLabel: Record<Task["priority"], string> = {
  critical: "Crítica",
  high: "Alta",
  normal: "Normal",
  low: "Baja",
};

/** With no confirmed user zone, instants are shown explicitly in UTC rather than in a guessed local zone. */
const UTC = "Etc/UTC";

function PrioritiesPanel({ view, timeZone }: Readonly<{ view: HoyView | null; timeZone: string | null }>) {
  const displayZone = timeZone ?? UTC;
  const suffix = timeZone === null ? " UTC" : "";
  return (
    <section className="priority-panel panel" aria-labelledby="hoy-priorities-title">
      <header className="panel-heading">
        <h3 id="hoy-priorities-title">Prioridades de hoy</h3>
        {view === null ? null : (
          <p className="panel-count">
            Tareas leídas a las <time dateTime={view.generatedAt}>{formatClock(view.generatedAt, displayZone)}{suffix}</time>
          </p>
        )}
      </header>
      {view === null ? (
        <SourceState compact headingLevel={4} state="unavailable" title="Prioridades no disponibles" detail="La API de datos personales no respondió. No se muestran tareas inventadas." />
      ) : view.priorities.length === 0 ? (
        <SourceState compact headingLevel={4} state="empty" title="No hay prioridades registradas" detail="Este espacio se completará cuando existan tareas reales." />
      ) : (
        <ol className="priority-list" aria-label="Prioridades de hoy">
          {view.priorities.map((task) => (
            <li className="priority-item" key={task.id} data-status={task.status}>
              <span className="priority-item__marker" aria-hidden="true" />
              <div>
                <h4>{task.title}</h4>
                <p>{task.dueAt === null ? "Sin fecha límite" : `${formatInstant(task.dueAt, displayZone)}${suffix}`}</p>
              </div>
              <span className={`priority priority--${task.priority}`}>{priorityLabel[task.priority]}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Page-neutral Hoy operational slot: day heading, priorities and agenda. Each input is an already-settled, independent
 * result (see `loadHoyOperational`), so a failing source only affects its own panel. `now` is an ISO instant.
 */
export function HoyOperationalSection({
  priorities,
  agenda,
  timeZone,
  now,
}: Readonly<{ priorities: Loadable<Snapshot>; agenda: AgendaResult; timeZone: TimeZoneResult; now: string }>) {
  const zone = timeZone.state === "unavailable" ? null : timeZone.value;
  const heading = zone === null ? null : buildDayHeading(new Date(now), zone);
  const view = priorities.state === "loaded" ? buildHoyView(priorities.value, new Date(now), zone ?? UTC) : null;
  const activeCount = view?.activePriorityCount ?? null;

  return (
    <section className="hoy-operational" aria-labelledby="hoy-operational-title">
      <header className="hoy-hero__copy">
        <p className="eyebrow">{heading?.dateLabel ?? "Hoy"}</p>
        <h2 id="hoy-operational-title">{heading?.greeting ?? "Tu día, en contexto"}</h2>
        <p>
          {activeCount === null
            ? "Las prioridades no están disponibles en este momento."
            : activeCount === 0
              ? "No tenés prioridades activas registradas para hoy."
              : `Tenés ${activeCount} ${activeCount === 1 ? "prioridad activa" : "prioridades activas"} para hoy.`}
        </p>
        {timeZone.state === "fallback" ? (
          <p className="hoy-operational__zone">
            No se pudo leer tu preferencia; usamos la zona horaria de la instalación ({timeZone.value}).
          </p>
        ) : null}
      </header>
      <div className="day-grid">
        <PrioritiesPanel view={view} timeZone={zone} />
        {zone === null ? (
          <section className="agenda-panel panel" aria-labelledby="hoy-agenda-title">
            <header className="panel-heading">
              <h3 id="hoy-agenda-title">Agenda de hoy</h3>
            </header>
            <SourceState compact headingLevel={4} state="error" title="No se pudo leer tu zona horaria" detail="Sin una zona confirmada no podemos saber qué día es para vos; revisala en Sistema." />
          </section>
        ) : (
          <AgendaPanel result={agenda} now={now} timeZone={zone} />
        )}
      </div>
    </section>
  );
}
