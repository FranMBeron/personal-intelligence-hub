"use client";

import type {
  CalendarChangeProposal,
  CalendarChangeSummary,
  CalendarEventDetail,
  CalendarEventPreview,
  CalendarEventTime,
  CalendarProposalStatus,
  CreateCalendarChangeProposalBody,
} from "@personal-intelligence-hub/contracts";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { BffRequestError } from "../../_lib/bff-request";
import { addDays, formatCalendarDate, formatClock, formatInstant } from "../../_lib/time-format";
import { CalendarClient, type CalendarApi } from "./calendar-client";
import "./system.css";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 30;
const CLOCK_TICK_MS = 15_000;

type Operation = CalendarChangeSummary["operation"];
type InvitationResponse = NonNullable<CalendarChangeSummary["invitationResponse"]>;
type GuestNotification = CalendarChangeSummary["guestNotification"];
type RecurrenceScope = CalendarChangeSummary["recurrenceScope"];

const operationCopy: Record<Operation, Readonly<{ title: string; confirm: string }>> = {
  create: { title: "Crear evento", confirm: "Confirmar cambio" },
  update: { title: "Modificar evento", confirm: "Confirmar cambio" },
  cancel: { title: "Cancelar un evento que organizas", confirm: "Confirmar cancelación del evento" },
  respond_invitation: { title: "Responder una invitación", confirm: "Confirmar respuesta a la invitación" },
};

export const invitationResponseLabels: Record<InvitationResponse, string> = {
  accepted: "Aceptar",
  declined: "Rechazar",
  tentative: "Quizás",
  removed: "Quitar de mi calendario",
};

const notificationLabels: Record<GuestNotification, string> = {
  all: "Se notificará a todos los invitados",
  external_only: "Solo se notificará a los invitados externos",
  none: "No se notificará a los invitados",
};

const notificationChoices: Record<GuestNotification, string> = {
  all: "Notificar a todos los invitados",
  external_only: "Notificar solo a invitados externos",
  none: "No notificar a los invitados",
};

const scopeLabels: Record<RecurrenceScope, string> = { single: "Solo este evento", series: "Toda la serie" };

const statusCopy: Partial<Record<CalendarProposalStatus, Readonly<{ heading: string; detail: string }>>> = {
  completed: { heading: "Cambio aplicado", detail: "Google Calendar aceptó el cambio confirmado." },
  rejected: { heading: "Propuesta rechazada", detail: "La propuesta se descartó y no se aplicó ningún cambio." },
  expired: { heading: "La propuesta venció", detail: "Las propuestas vencen a los 15 minutos. Pide a Central una nueva si todavía quieres el cambio." },
  conflict: { heading: "El evento cambió después de la propuesta", detail: "No se aplicó nada. Hace falta una nueva propuesta con el estado actual del evento." },
  failed: { heading: "No se pudo aplicar el cambio", detail: "Google Calendar no aplicó el cambio." },
};

const proposalReasonLabels: Readonly<Record<string, string>> = {
  proposal_expired: "La propuesta venció antes de confirmarse.",
  provider_state_changed: "El evento cambió en Google Calendar.",
  provider_permission_denied: "Google Calendar rechazó el permiso necesario.",
  provider_temporarily_unavailable: "Google Calendar no respondió temporalmente.",
  cancel_not_permitted: "Solo se pueden cancelar eventos que organizas.",
};

const formatEventTime = (time: CalendarEventTime, timeZone: string): string => {
  if (time.kind === "all_day") {
    const last = addDays(time.endDateExclusive, -1);
    return last === time.startDate
      ? `${formatCalendarDate(time.startDate)} · todo el día`
      : `${formatCalendarDate(time.startDate)} – ${formatCalendarDate(last)} · todo el día`;
  }
  return `${formatInstant(time.start, timeZone)} – ${formatClock(time.end, timeZone)}`;
};

function Preview({ label, preview, timeZone }: Readonly<{ label: string; preview: CalendarEventPreview; timeZone: string }>) {
  return (
    <div className="calendar-proposal__preview">
      <h5>{label}</h5>
      <p className="calendar-proposal__title">{preview.title}</p>
      <p>{formatEventTime(preview.time, timeZone)}</p>
      {preview.location === undefined || preview.location === "" ? null : <p>Lugar: {preview.location}</p>}
      <p>{preview.attendeeCount === 1 ? "1 invitado" : `${preview.attendeeCount} invitados`}</p>
    </div>
  );
}

const isTerminal = (status: CalendarProposalStatus): boolean => status !== "pending" && status !== "executing";

/**
 * Structured review of one Calendar change proposal. Loading it never executes it: only the explicit
 * confirm button sends `{expectedVersion}`, once, and a conflict always requires a new proposal.
 */
export function CalendarProposal({ proposalId, client, now, timeZone }: Readonly<{
  proposalId: string;
  client?: CalendarApi;
  /** Fixed clock for deterministic rendering; when omitted the component ticks on its own. */
  now?: string;
  /** Zone for the expiry time; defaults to the proposal's own zone. */
  timeZone?: string;
}>) {
  const calendar = useRef<CalendarApi>(client ?? new CalendarClient()).current;
  const [proposal, setProposal] = useState<CalendarChangeProposal | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const [focusResult, setFocusResult] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    if (now !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [now]);

  useEffect(() => {
    const controller = new AbortController();
    setProposal(null);
    setLoadFailure(null);
    calendar.proposal(proposalId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setProposal(value);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadFailure(error instanceof BffRequestError && error.status === 404
        ? "La propuesta no existe o no pertenece a tu sesión."
        : "No se pudo cargar la propuesta. Inténtalo de nuevo en unos minutos.");
    });
    return () => controller.abort();
  }, [calendar, proposalId]);

  useEffect(() => {
    if (!focusResult) return;
    resultRef.current?.focus();
    setFocusResult(false);
  }, [focusResult]);

  const reload = useCallback(async () => {
    try {
      const latest = await calendar.proposal(proposalId);
      if (mounted.current) setProposal(latest);
      return latest;
    } catch {
      return null;
    }
  }, [calendar, proposalId]);

  const pollUntilTerminal = useCallback((attempt = 0) => {
    if (attempt >= MAX_POLLS) {
      setNotice("El cambio sigue en curso. Vuelve a abrir la propuesta más tarde para ver el resultado.");
      return;
    }
    pollTimer.current = setTimeout(() => {
      void reload().then((latest) => {
        if (!mounted.current) return;
        if (latest === null || !isTerminal(latest.status)) pollUntilTerminal(attempt + 1);
        else setFocusResult(true);
      });
    }, POLL_INTERVAL_MS);
  }, [reload]);

  const decide = async (decision: "confirm" | "reject") => {
    if (busyRef.current || proposal === null) return;
    busyRef.current = true;
    setBusy(decision);
    setNotice(null);
    try {
      const result = decision === "confirm"
        ? await calendar.confirm(proposal.id, proposal.version)
        : await calendar.reject(proposal.id, proposal.version);
      if (!mounted.current) return;
      setProposal(result);
      if (result.status === "executing") pollUntilTerminal();
      else setFocusResult(true);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof BffRequestError && (error.status === 401 || error.status === 403)) {
        setNotice(decision === "confirm"
          ? "Tu sesión no tiene permiso para confirmar cambios de calendario. No se aplicó nada."
          : "Tu sesión no tiene permiso para descartar esta propuesta.");
      } else if (error instanceof BffRequestError && (error.status === 409 || error.status === 410)) {
        setNotice("La propuesta cambió o ya no es válida. No se reenvió la confirmación: pide a Central una nueva propuesta.");
        await reload();
      } else {
        setNotice("No se pudo completar la acción. Se recargó el estado de la propuesta; revísalo antes de volver a intentarlo.");
        await reload();
      }
      setFocusResult(true);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  if (loadFailure !== null) return <p className="calendar-proposal__error" role="alert">{loadFailure}</p>;
  if (proposal === null) return <p className="calendar-proposal__loading" role="status">Cargando propuesta…</p>;

  const { summary } = proposal;
  const copy = operationCopy[summary.operation];
  const clock = now === undefined ? tick : Date.parse(now);
  const expiredLocally = proposal.status === "pending" && clock >= Date.parse(proposal.expiresAt);
  const effectiveStatus: CalendarProposalStatus = expiredLocally ? "expired" : proposal.status;
  const invalidCancel = summary.operation === "cancel" && summary.organizerRelationship === "other";
  const canDecide = effectiveStatus === "pending" && !invalidCancel;
  const terminal = statusCopy[effectiveStatus];
  const reason = proposal.safeReasonCode === undefined ? null : proposalReasonLabels[proposal.safeReasonCode] ?? null;
  const expiryZone = timeZone ?? summary.timeZone;

  return (
    <section className="calendar-proposal" aria-label={`Revisar propuesta: ${copy.title}`} data-status={effectiveStatus}>
      <h4>{copy.title}</h4>
      {summary.operation === "respond_invitation" && summary.invitationResponse !== undefined
        ? <p className="calendar-proposal__answer">Respuesta: {invitationResponseLabels[summary.invitationResponse]}</p>
        : null}
      <div className="calendar-proposal__comparison">
        {summary.before === undefined ? null : <Preview label={summary.operation === "cancel" ? "Evento" : "Antes"} preview={summary.before} timeZone={summary.timeZone} />}
        {summary.after === undefined ? null : <Preview label={summary.before === undefined ? "Nuevo evento" : "Después"} preview={summary.after} timeZone={summary.timeZone} />}
      </div>
      <ul className="calendar-proposal__facts">
        <li>Calendario: {summary.calendarDisplayName}</li>
        <li>Zona horaria: {summary.timeZone}</li>
        <li>Alcance: {scopeLabels[summary.recurrenceScope]}</li>
        <li>{summary.organizerRelationship === "self" ? "Lo organizas tú" : "Lo organiza otra persona"}</li>
        <li>{notificationLabels[summary.guestNotification]}</li>
      </ul>
      <p className="calendar-proposal__expiry">Vence: <time dateTime={proposal.expiresAt}>{formatInstant(proposal.expiresAt, expiryZone)}</time></p>

      {invalidCancel ? (
        <p className="calendar-proposal__error" role="alert">Esta propuesta intenta cancelar un evento que organiza otra persona y no se puede confirmar. Para dejar ese evento, pide una respuesta a la invitación.</p>
      ) : null}
      {notice === null ? null : <p className="calendar-proposal__error" role="alert">{notice}</p>}

      {effectiveStatus === "executing" ? <p className="calendar-proposal__progress" role="status">Aplicando el cambio en Google Calendar…</p> : null}
      {terminal === undefined ? null : (
        <div className="calendar-proposal__result" role="status">
          <h5 ref={resultRef} tabIndex={-1}>{terminal.heading}</h5>
          <p>{terminal.detail}</p>
          {reason === null ? null : <p>{reason}</p>}
        </div>
      )}

      {canDecide ? (
        <div className="calendar-proposal__actions">
          <p className="calendar-proposal__hint">Nada cambia hasta que lo confirmes. Revisar o abrir esta propuesta no la ejecuta.</p>
          <button className="button" type="button" onClick={() => { void decide("confirm"); }} disabled={busy !== null}>{copy.confirm}</button>
          <button className="button button--quiet" type="button" onClick={() => { void decide("reject"); }} disabled={busy !== null}>Descartar propuesta</button>
        </div>
      ) : null}
    </section>
  );
}

const newIntentKey = (): string => crypto.randomUUID();

/**
 * Prepares (never executes) a change for one event. An event you organize can be cancelled; an invitation
 * organized by someone else can only be answered. The two are separate forms with separate copy.
 */
export function CalendarEventActions({ event, client, onProposed }: Readonly<{
  event: CalendarEventDetail;
  client?: CalendarApi;
  onProposed: (proposalId: string) => void;
}>) {
  const calendar = useRef<CalendarApi>(client ?? new CalendarClient()).current;
  const [response, setResponse] = useState<InvitationResponse | null>(null);
  const [scope, setScope] = useState<RecurrenceScope | null>(event.recurrence.recurring ? null : "single");
  const [notification, setNotification] = useState<GuestNotification | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const intent = useRef<{ body: string; key: string } | null>(null);
  const busy = useRef(false);
  const name = useId();
  const isOrganizer = event.organizerRelationship === "self";
  const ready = scope !== null && notification !== null && (isOrganizer || response !== null);

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!ready || busy.current) return;
    const body: CreateCalendarChangeProposalBody = isOrganizer
      ? { operation: "cancel", eventRef: event.eventRef, recurrenceScope: scope, guestNotification: notification }
      : { operation: "respond_invitation", eventRef: event.eventRef, recurrenceScope: scope, response: response!, guestNotification: notification };
    const serialized = JSON.stringify(body);
    // The same intent keeps its idempotency key across retries; changing a choice is a new intent.
    if (intent.current?.body !== serialized) intent.current = { body: serialized, key: newIntentKey() };
    busy.current = true;
    setPending(true);
    setFailure(null);
    try {
      const proposal = await calendar.propose(body, intent.current.key);
      onProposed(proposal.id);
    } catch {
      setFailure("No se pudo preparar la propuesta. Puedes reintentar: no se creará una propuesta duplicada.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const radios = <T extends string>(legend: string, group: string, options: Record<T, string>, value: T | null, set: (value: T) => void) => (
    <fieldset className="calendar-actions__choices">
      <legend>{legend}</legend>
      {(Object.keys(options) as T[]).map((option) => (
        <label key={option}>
          <input type="radio" name={`${name}-${group}`} value={option} checked={value === option} onChange={() => set(option)} disabled={pending} />
          {options[option]}
        </label>
      ))}
    </fieldset>
  );

  return (
    <form className="calendar-actions" aria-label={`${isOrganizer ? "Cancelar evento" : "Responder invitación"}: ${event.title}`} onSubmit={(formEvent) => { void submit(formEvent); }}>
      <h4>{isOrganizer ? "Cancelar un evento que organizas" : "Responder una invitación"}</h4>
      <p className="calendar-actions__event">{event.title}</p>
      <p className="calendar-actions__hint">
        {isOrganizer
          ? "Se cancelará para todas las personas invitadas. Primero verás un resumen; nada cambia hasta que lo confirmes."
          : "La organiza otra persona: solo puedes responder o quitarla de tu calendario. Primero verás un resumen; nada cambia hasta que lo confirmes."}
      </p>
      {isOrganizer ? null : radios("Tu respuesta", "response", invitationResponseLabels, response, setResponse)}
      {event.recurrence.recurring ? radios("Alcance", "scope", scopeLabels, scope, setScope) : null}
      {radios("Notificaciones", "notification", notificationChoices, notification, setNotification)}
      {failure === null ? null : <p className="calendar-proposal__error" role="alert">{failure}</p>}
      <button className="button" type="submit" disabled={!ready || pending}>{isOrganizer ? "Preparar cancelación" : "Preparar respuesta"}</button>
    </form>
  );
}
