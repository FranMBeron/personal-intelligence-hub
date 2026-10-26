"use client";

import { useEffect, useRef, useState } from "react";

import { formatInstant } from "../../_lib/time-format";
import { subscribeCalendarStatus } from "../_lib/calendar-status-events";
import { SystemStatusClient, type SystemStatusLoader } from "../_lib/system-client";
import { buildSystemViewFromSnapshot, type Loadable, type SystemSnapshot } from "../_lib/system-view";
import { LiveRegion } from "./live-region";
import { SourceStatusCard } from "./source-status-card";
import "./system.css";

const aggregateIcon = { positive: "✓", warning: "!", danger: "!", neutral: "–" } as const;

/** Deployment configuration does not change at runtime, so a failed refresh cannot turn "not configured" into "unavailable". */
const keepConfiguration = <T,>(previous: Loadable<T>, next: Loadable<T>): Loadable<T> =>
  previous.state === "not_configured" && next.state === "unavailable" ? previous : next;

/**
 * Page-neutral Sistema status slot. Renders only evidence reported by each source and refreshes on demand.
 * `now` is supplied by the caller so server and client render the same relative ages.
 */
export function SystemStatusSection({ initial, now, timeZone, client }: Readonly<{
  initial: SystemSnapshot;
  now: string;
  timeZone: string;
  client?: SystemStatusLoader;
}>) {
  const loader = useRef<SystemStatusLoader>(client ?? new SystemStatusClient()).current;
  const [snapshot, setSnapshot] = useState(initial);
  const [renderedAt, setRenderedAt] = useState(now);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);
  // A newer server render (for example after a page refresh) replaces the local snapshot.
  useEffect(() => { setSnapshot(initial); setRenderedAt(now); }, [initial, now]);
  // A Calendar status learned by the Calendar settings (connect, disconnect, refresh) replaces the card's value.
  useEffect(() => subscribeCalendarStatus((status) => {
    setSnapshot((previous) => ({ ...previous, calendar: { state: "loaded", value: status } }));
    setRenderedAt(new Date().toISOString());
  }), []);

  const refresh = async () => {
    if (inFlight.current !== null) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setPending(true);
    setFailure(false);
    try {
      const next = await loader.load(controller.signal);
      if (controller.signal.aborted) return;
      setSnapshot((previous) => ({
        connectors: keepConfiguration(previous.connectors, next.connectors),
        agents: keepConfiguration(previous.agents, next.agents),
        calendar: keepConfiguration(previous.calendar, next.calendar),
      }));
      setRenderedAt(new Date().toISOString());
    } catch {
      if (!controller.signal.aborted) setFailure(true);
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };

  const view = buildSystemViewFromSnapshot(snapshot, new Date(renderedAt));

  return (
    <section className="system-status" aria-label="Estado del sistema" data-tone={view.tone} aria-busy={pending}>
      <header className="system-status__summary">
        <span className="system-status__icon" aria-hidden="true">{aggregateIcon[view.tone]}</span>
        <div className="system-status__copy">
          <h2>{view.label}</h2>
          <p>{view.detail}</p>
          {view.checkedAt === null ? null : (
            <p className="system-status__checked">Comprobación más antigua: <time dateTime={view.checkedAt}>{formatInstant(view.checkedAt, timeZone)}</time></p>
          )}
        </div>
        <button className="button button--quiet system-status__refresh" type="button" onClick={() => { void refresh(); }} disabled={pending}>
          {pending ? "Comprobando…" : "Actualizar estado"}
        </button>
      </header>
      <LiveRegion kind="alert">
        {failure ? <p className="system-status__error">No se pudo actualizar el estado. Se muestran los últimos datos obtenidos.</p> : null}
      </LiveRegion>
      <div className="system-status__cards">
        {view.cards.map((card) => <SourceStatusCard key={card.key} card={card} timeZone={timeZone} />)}
      </div>
      <ul className="system-status__telemetry" aria-label="Telemetría del servidor">
        {view.telemetry.map((metric) => (
          <li key={metric.key}><span>{metric.label}</span> <strong>{metric.value === null ? "No medido" : `${metric.value}${metric.unit}`}</strong></li>
        ))}
      </ul>
    </section>
  );
}
