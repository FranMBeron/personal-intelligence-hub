import type { ReactNode } from "react";

import { buildAgendaView, localDayKey, type AgendaResult, type AgendaRow } from "../_lib/agenda";
import { formatClock, formatInstant } from "../_lib/time-format";
import { SourceState } from "./source-state";

export { toAgendaResult, type AgendaResult } from "../_lib/agenda";

const titleId = "hoy-agenda-title";

/** Provider text is rendered only as React text children: never markup, never links. */
function AgendaItem({ row }: Readonly<{ row: AgendaRow }>) {
  return (
    <li className="agenda-item" data-phase={row.phase ?? "all_day"}>
      <span className="agenda-item__time">{row.timeLabel}</span>
      <div className="agenda-item__copy">
        <h4>{row.title}</h4>
        {row.location === null ? null : <p className="agenda-item__location">{row.location}</p>}
        <p className="agenda-item__calendar">
          {row.calendarDisplayName}
          {row.tentative ? " · Provisional" : ""}
        </p>
      </div>
    </li>
  );
}

function Highlight({ label, row }: Readonly<{ label: string; row: AgendaRow }>) {
  return (
    <div className="agenda-highlight" data-phase={row.phase ?? "all_day"}>
      <span className="eyebrow">{label}</span>
      <span className="agenda-highlight__title">{row.title}</span>
      <span className="agenda-highlight__time">{row.timeLabel}</span>
    </div>
  );
}

function Panel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <section className="agenda-panel panel" aria-labelledby={titleId}>
      <header className="panel-heading">
        <h3 id={titleId}>Agenda de hoy</h3>
      </header>
      {children}
    </section>
  );
}

/**
 * Today's agenda for `timeZone`, from an explicit source state. `now` is an ISO instant supplied by the caller so
 * rendering is deterministic and independent of the host zone.
 */
export function AgendaPanel({ result, now, timeZone }: Readonly<{ result: AgendaResult; now: string; timeZone: string }>) {
  switch (result.state) {
    case "unconfigured":
      return <Panel><SourceState compact headingLevel={4} state="not_configured" title="Calendario no configurado" detail="Conecta un calendario en Sistema para ver tu agenda. No mostramos eventos de ejemplo." /></Panel>;
    case "unavailable":
      return <Panel><SourceState compact headingLevel={4} state="unavailable" title="Agenda no disponible" detail="El calendario no respondió. No se muestran eventos inventados." /></Panel>;
    case "reauthorization":
      return <Panel><SourceState compact headingLevel={4} state="requires_reauthorization" title="Hay que volver a autorizar el calendario" detail="La autorización venció o fue revocada. Puedes renovarla desde Sistema." /></Panel>;
    case "permission_denied":
      return <Panel><SourceState compact headingLevel={4} state="error" title="Sin permiso para leer el calendario" detail="El proveedor rechazó la lectura de los calendarios seleccionados." /></Panel>;
    case "attention":
      return <Panel><SourceState compact headingLevel={4} state="requires_attention" title="El calendario necesita atención" detail="Revisa la configuración del calendario en Sistema." /></Panel>;
    case "available":
    case "stale":
      break;
  }

  const view = buildAgendaView(result.agenda, new Date(now), timeZone);
  if (!view.coversDay) {
    return <Panel><SourceState compact headingLevel={4} state="unavailable" title="Agenda no disponible" detail="La agenda recibida no cubre tu día completo; no la mostramos como vacía." /></Panel>;
  }
  const stale = result.state === "stale";
  const freshness = (
    <p className="agenda-freshness">
      {stale ? "Última agenda leída: " : "Agenda actualizada: "}
      <time dateTime={view.generatedAt}>
        {localDayKey(new Date(view.generatedAt), timeZone) === view.dayKey ? formatClock(view.generatedAt, timeZone) : formatInstant(view.generatedAt, timeZone)}
      </time>
    </p>
  );

  return (
    <Panel>
      {stale ? <SourceState compact headingLevel={4} state="stale" title="Datos sin actualizar" detail="El calendario no confirmó datos recientes; mostramos la última agenda conocida." /> : null}
      {view.isEmpty && !stale ? (
        <SourceState compact headingLevel={4} state="empty" title="No hay eventos hoy" detail="Tus calendarios seleccionados no tienen eventos para este día." />
      ) : null}
      {view.current === null ? null : <Highlight label="Ahora" row={view.current} />}
      {view.next === null ? null : <Highlight label="Siguiente" row={view.next} />}
      {view.isEmpty ? null : (
        <ol className="agenda-list" aria-label="Eventos de hoy">
          {[...view.allDay, ...view.timed].map((row) => <AgendaItem key={row.key} row={row} />)}
        </ol>
      )}
      {freshness}
    </Panel>
  );
}
