"use client";

import type {
  CalendarAuthorizationStart,
  CalendarSelection,
  CalendarSelectionEntry,
  CalendarSourceStatus,
  SourceStatus,
} from "@personal-intelligence-hub/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { StatusBadge } from "../../_components/status-badge";
import { BffRequestError } from "../../_lib/bff-request";
import { formatClock, formatInstant } from "../../_lib/time-format";
import { publishCalendarStatus } from "../_lib/calendar-status-events";
import { reasonLabel } from "../_lib/system-view";
import { CalendarClient, type CalendarApi } from "./calendar-client";
import { LiveRegion } from "./live-region";
import "./system.css";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 24;
const RETURN_CHECK_INTERVAL_MS = 3_000;
const RETURN_CHECKS = 5;

type Notice = Readonly<{ kind: "status" | "alert"; text: string; recheck?: boolean }>;
/** A status read either lands, fails, or was overtaken by a newer read (or the unmount) and must be ignored. */
type StatusRead = CalendarSourceStatus | "failed" | "superseded";
type Busy = "auth" | "bootstrap" | "disconnect" | "save" | "discover" | null;
type Flags = Readonly<{ readEnabled: boolean; writeEnabled: boolean }>;

const connectionLabel = (status: CalendarSourceStatus): string => {
  switch (status.state) {
    case "available": return status.stale ? "Conectado, datos sin actualizar" : "Conectado";
    case "not_configured": return "Sin conectar";
    case "requires_reauthorization": return "Requiere volver a autorizar";
    case "requires_attention": return "Requiere atención";
    case "degraded": return "Degradado";
    case "unavailable": return "No disponible";
  }
};

const connectionTone = (status: CalendarSourceStatus) =>
  status.state === "available" && !status.stale ? "positive" as const
    : status.state === "unavailable" ? "danger" as const
      : status.state === "not_configured" ? "neutral" as const : "warning" as const;

const roleLabels: Record<CalendarSelectionEntry["accessRole"], string> = {
  owner: "propietario",
  writer: "editor",
  reader: "lector",
  free_busy_reader: "solo disponibilidad",
};

const canWriteRole = (entry: CalendarSelectionEntry): boolean => entry.accessRole === "owner" || entry.accessRole === "writer";

const awaitingAuthorization = (status: CalendarSourceStatus): boolean =>
  status.state === "not_configured" || status.state === "requires_reauthorization";

/** Primary first; the remaining calendars keep the provider order. */
const ordered = (items: readonly CalendarSelectionEntry[]): CalendarSelectionEntry[] =>
  [...items.filter((item) => item.isPrimary), ...items.filter((item) => !item.isPrimary)];

const offFlags: Flags = { readEnabled: false, writeEnabled: false };

/** Write only applies to a read calendar whose provider role can write; anything else is never sent nor shown as on. */
const effectiveWrite = (row: CalendarSelectionEntry, flags: Flags): boolean =>
  flags.readEnabled && flags.writeEnabled && canWriteRole(row);

const hasUnsavedEdits = (saved: CalendarSelection, draft: ReadonlyMap<string, Flags>, discovered: readonly CalendarSelectionEntry[]): boolean =>
  discovered.length > 0 || saved.items.some((item) => {
    const flags = draft.get(item.calendarRef);
    return flags === undefined || flags.readEnabled !== item.readEnabled || flags.writeEnabled !== item.writeEnabled;
  });

const flagsFrom = (items: readonly CalendarSelectionEntry[]): Map<string, Flags> =>
  new Map(items.map((item) => [item.calendarRef, { readEnabled: item.readEnabled, writeEnabled: item.writeEnabled }]));

const disconnectedStatus = (source: SourceStatus): CalendarSourceStatus => ({
  state: source.state,
  checkedAt: source.checkedAt,
  stale: source.stale,
  canRead: false,
  canProposeChanges: false,
  primaryCalendarConfigured: false,
  additionalCalendarCount: 0,
});

/**
 * Human Calendar connection and allowlist. OAuth starts only on click and continues in the system browser through
 * an explicit link; read and write are separate, and write needs a saved read selection plus a writer role.
 */
export function CalendarSettings({ initialStatus, initialSelection, timeZone, returnState = null, client, onDisconnected }: Readonly<{
  initialStatus: CalendarSourceStatus;
  initialSelection: CalendarSelection;
  timeZone: string;
  /** Fixed value from the OAuth callback redirect (`?calendar=`); never carries tokens. */
  returnState?: "connected" | "attention" | null;
  client?: CalendarApi;
  onDisconnected?: () => void;
}>) {
  const calendar = useRef<CalendarApi>(client ?? new CalendarClient()).current;
  const [status, setStatus] = useState(initialStatus);
  const [saved, setSaved] = useState(initialSelection);
  const [draft, setDraft] = useState(() => flagsFrom(initialSelection.items));
  const [discovered, setDiscovered] = useState<readonly CalendarSelectionEntry[]>([]);
  const [authLink, setAuthLink] = useState<CalendarAuthorizationStart | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [focusTarget, setFocusTarget] = useState<"link" | "connect" | "status" | "disconnect" | null>(null);
  const busyRef = useRef<Busy>(null);
  const mounted = useRef(true);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const connectRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLHeadingElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const explanationId = useId();

  const lifetime = useRef<AbortController | null>(null);
  const statusSeq = useRef(0);
  const selectionSeq = useRef(0);
  const dirty = useRef(false);
  const returnRun = useRef(0);
  const returnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  useEffect(() => { dirty.current = hasUnsavedEdits(saved, draft, discovered); }, [saved, draft, discovered]);

  // Keep the Sistema status card in step with what this view learned (for example, a disconnect).
  useEffect(() => {
    if (status !== initialStatus) publishCalendarStatus(status);
  }, [initialStatus, status]);

  useEffect(() => {
    if (focusTarget === null) return;
    ({ link: linkRef, connect: connectRef, status: statusRef, disconnect: disconnectRef })[focusTarget].current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const applySelection = useCallback((selection: CalendarSelection) => {
    // Anything this view writes supersedes a background read still in flight.
    selectionSeq.current += 1;
    dirty.current = false;
    setSaved(selection);
    setDraft(flagsFrom(selection.items));
    setDiscovered([]);
  }, []);

  /** Runs one user action at a time; duplicate clicks while pending are ignored. */
  const exclusive = useCallback(async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    if (busyRef.current !== null) return;
    busyRef.current = kind;
    setBusy(kind);
    try { await action(); } finally {
      busyRef.current = null;
      if (mounted.current) setBusy(null);
    }
  }, []);

  /**
   * Background selection read. It never replaces unsaved edits or races a save in flight unless `force`d
   * (an explicit reload after a conflict), and a reply overtaken by a newer read or write is dropped.
   */
  const loadSelection = useCallback(async ({ force = false }: Readonly<{ force?: boolean }> = {}) => {
    const blocked = () => !force && (dirty.current || busyRef.current === "save");
    if (blocked()) return;
    const seq = ++selectionSeq.current;
    try {
      const selection = await calendar.selection(lifetime.current?.signal);
      if (!mounted.current || seq !== selectionSeq.current || blocked()) return;
      applySelection(selection);
    } catch {
      if (mounted.current && seq === selectionSeq.current) {
        setNotice({ kind: "alert", text: "No se pudo cargar la selección de calendarios. Actualiza el estado para intentarlo de nuevo." });
      }
    }
  }, [applySelection, calendar]);

  /** Status written by an action supersedes any background read still in flight. */
  const acceptStatus = useCallback((next: CalendarSourceStatus) => {
    statusSeq.current += 1;
    setStatus(next);
  }, []);

  const refreshStatus = useCallback(async (): Promise<StatusRead> => {
    const seq = ++statusSeq.current;
    const signal = lifetime.current?.signal;
    try {
      const next = await calendar.status(signal);
      if (!mounted.current || seq !== statusSeq.current) return "superseded";
      setStatus(next);
      if (!awaitingAuthorization(next)) {
        setAuthLink(null);
        if (next.state === "available") await loadSelection();
      }
      return next;
    } catch {
      return signal?.aborted === true || seq !== statusSeq.current ? "superseded" : "failed";
    }
  }, [calendar, loadSelection]);

  /** After the OAuth return: read the status a bounded number of times and always end with an outcome. */
  const checkReturn = useCallback(() => {
    if (returnTimer.current !== null) clearTimeout(returnTimer.current);
    const run = ++returnRun.current;
    const attempt = async (count: number): Promise<void> => {
      const read = await refreshStatus();
      if (!mounted.current || run !== returnRun.current) return;
      if (read === "failed") {
        setNotice({ kind: "alert", text: "No se pudo comprobar el estado de Google Calendar tras la autorización. Comprueba de nuevo en unos segundos.", recheck: true });
        return;
      }
      if (read !== "superseded" && read.state === "available") {
        setNotice({ kind: "status", text: "Google Calendar quedó conectado." });
        return;
      }
      if (read !== "superseded" && read.state === "requires_attention") {
        setNotice({ kind: "alert", text: "La autorización terminó, pero la configuración sigue pendiente. Revisa el motivo indicado y usa «Reintentar configuración»." });
        return;
      }
      if (count < RETURN_CHECKS) {
        returnTimer.current = setTimeout(() => { void attempt(count + 1); }, RETURN_CHECK_INTERVAL_MS);
        return;
      }
      setNotice({ kind: "alert", text: "Google Calendar todavía no aparece como conectado. Comprueba de nuevo o vuelve a conectar.", recheck: true });
    };
    void attempt(1);
  }, [refreshStatus]);

  const recheck = () => {
    setNotice({ kind: "status", text: "Comprobando el estado de Google Calendar…" });
    checkReturn();
  };

  // The OAuth callback redirects back with a fixed marker; re-read the status (no token is read here).
  useEffect(() => {
    if (returnState === null) return;
    if (returnState === "attention") {
      setNotice({ kind: "alert", text: "La autorización no se completó: se canceló, se rechazó o necesita atención. Puedes intentarlo de nuevo." });
      void refreshStatus();
    } else {
      setNotice({ kind: "status", text: "Google Calendar volvió del navegador. Comprobando el estado…" });
      checkReturn();
    }
    return () => {
      returnRun.current += 1;
      if (returnTimer.current !== null) clearTimeout(returnTimer.current);
      returnTimer.current = null;
    };
  }, [checkReturn, refreshStatus, returnState]);

  // While the user completes OAuth in the system browser: refresh on return (focus/visibility) and poll a bounded number of times.
  useEffect(() => {
    if (authLink === null) return;
    let polls = 0;
    const onReturn = () => { if (document.visibilityState !== "hidden") void refreshStatus(); };
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) { clearInterval(timer); return; }
      void refreshStatus();
    }, POLL_INTERVAL_MS);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [authLink, refreshStatus]);

  const startAuthorization = () => exclusive("auth", async () => {
    setNotice(null);
    try {
      const start = await calendar.startAuthorization();
      if (!mounted.current) return;
      if (new URL(start.authorizationUrl).protocol !== "https:") throw new Error("Unsafe authorization link.");
      setAuthLink(start);
      setFocusTarget("link");
    } catch (error) {
      if (!mounted.current) return;
      setNotice({ kind: "alert", text: error instanceof BffRequestError && error.status === 403
        ? "Tu sesión no tiene permiso para conectar Google Calendar."
        : "No se pudo iniciar la autorización. Inténtalo de nuevo en unos minutos." });
    }
  });

  const retryBootstrap = () => exclusive("bootstrap", async () => {
    setNotice(null);
    try {
      const next = await calendar.bootstrap();
      if (!mounted.current) return;
      acceptStatus(next);
      if (next.state === "available") await loadSelection();
      setNotice(next.state === "available"
        ? { kind: "status", text: "Configuración completada." }
        : { kind: "alert", text: "La configuración sigue pendiente. Revisa el motivo indicado e inténtalo de nuevo." });
      setFocusTarget("status");
    } catch {
      if (mounted.current) setNotice({ kind: "alert", text: "No se pudo reintentar la configuración. Inténtalo de nuevo." });
    }
  });

  const disconnect = () => exclusive("disconnect", async () => {
    setNotice(null);
    try {
      const source = await calendar.disconnect();
      if (!mounted.current) return;
      acceptStatus(disconnectedStatus(source));
      applySelection({ version: saved.version, items: [] });
      setAuthLink(null);
      setConfirmingDisconnect(false);
      setNotice({ kind: "status", text: "Google Calendar se desconectó. Se descartaron la selección y las propuestas abiertas en esta vista." });
      onDisconnected?.();
      setFocusTarget("connect");
    } catch {
      if (mounted.current) setNotice({ kind: "alert", text: "No se pudo desconectar Google Calendar. La conexión no cambió." });
    }
  });

  const discover = () => exclusive("discover", async () => {
    setNotice(null);
    try {
      const found = await calendar.calendars();
      if (!mounted.current) return;
      const known = new Set(saved.items.map((item) => item.calendarRef));
      // Additional calendars start disabled: access granted by Google is not authorization in PIH.
      setDiscovered(found.items.filter((item) => !known.has(item.calendarRef)).map((item) => ({ ...item, readEnabled: false, writeEnabled: false })));
    } catch {
      if (mounted.current) setNotice({ kind: "alert", text: "No se pudieron consultar otros calendarios." });
    }
  });

  const save = () => exclusive("save", async () => {
    setNotice(null);
    const rows = ordered([...saved.items, ...discovered]);
    try {
      const next = await calendar.updateSelection({
        expectedVersion: saved.version,
        calendars: rows.map((row) => {
          const flags = draft.get(row.calendarRef) ?? offFlags;
          return { calendarRef: row.calendarRef, readEnabled: flags.readEnabled, writeEnabled: effectiveWrite(row, flags) };
        }),
      });
      if (!mounted.current) return;
      applySelection(next);
      setNotice({ kind: "status", text: "Selección guardada." });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof BffRequestError && error.status === 409) {
        await loadSelection({ force: true });
        if (mounted.current) setNotice({ kind: "alert", text: "La selección cambió en otro lugar. Se cargó la versión actual; revísala y guarda de nuevo." });
        return;
      }
      setNotice({ kind: "alert", text: "No se pudo guardar la selección. No se aplicó ningún cambio." });
    }
  });

  const setFlag = (ref: string, change: Partial<Flags>) => setDraft((previous) => {
    const next = new Map(previous);
    const current = next.get(ref) ?? offFlags;
    const merged = { ...current, ...change };
    next.set(ref, merged.readEnabled ? merged : offFlags);
    return next;
  });

  const rows = ordered([...saved.items, ...discovered]);
  const savedRead = new Set(saved.items.filter((item) => item.readEnabled).map((item) => item.calendarRef));
  const connected = status.state !== "not_configured";
  const reason = reasonLabel(status.safeReasonCode);

  return (
    <section className="calendar-settings" aria-labelledby={headingId}>
      <header className="calendar-settings__header">
        <h3 id={headingId} ref={statusRef} tabIndex={-1}>Conexión con Google Calendar</h3>
        <StatusBadge tone={connectionTone(status)}>{connectionLabel(status)}</StatusBadge>
      </header>
      <p className="calendar-settings__fact">Comprobado: <time dateTime={status.checkedAt}>{formatInstant(status.checkedAt, timeZone)}</time></p>
      {reason === null ? null : <p className="calendar-settings__reason">{reason}</p>}

      <div className="calendar-settings__actions">
        {status.state === "not_configured" ? (
          <button ref={connectRef} className="button" type="button" onClick={() => { void startAuthorization(); }} disabled={busy !== null}>Conectar Google Calendar</button>
        ) : null}
        {status.state === "requires_reauthorization" ? (
          <button ref={connectRef} className="button" type="button" onClick={() => { void startAuthorization(); }} disabled={busy !== null}>Volver a autorizar</button>
        ) : null}
        {status.state === "requires_attention" ? (
          <button className="button" type="button" onClick={() => { void retryBootstrap(); }} disabled={busy !== null}>{busy === "bootstrap" ? "Reintentando…" : "Reintentar configuración"}</button>
        ) : null}
        {connected && !confirmingDisconnect ? (
          <button ref={disconnectRef} className="button button--quiet" type="button" onClick={() => setConfirmingDisconnect(true)} disabled={busy !== null}>Desconectar Google Calendar</button>
        ) : null}
      </div>

      {authLink === null ? null : (
        <div className="calendar-settings__handoff">
          <p>La autorización se abre en tu navegador del sistema, no dentro de esta ventana.</p>
          <a ref={linkRef} className="button" href={authLink.authorizationUrl} target="_blank" rel="noopener noreferrer">Continuar en navegador<span className="sr-only"> (se abre fuera de la aplicación)</span></a>
          <p className="calendar-settings__fact">El enlace vence a las <time dateTime={authLink.expiresAt}>{formatClock(authLink.expiresAt, timeZone)}</time>. Al volver, el estado se actualiza solo.</p>
        </div>
      )}

      {confirmingDisconnect ? (
        <div className="calendar-settings__confirm" role="group" aria-label="Confirmar desconexión de Google Calendar">
          <p>Se revocará el acceso guardado y se descartarán la selección y las propuestas abiertas. Tus eventos en Google no cambian.</p>
          <button className="button" type="button" onClick={() => { void disconnect(); }} disabled={busy !== null}>Confirmar desconexión</button>
          <button className="button button--quiet" type="button" onClick={() => { setConfirmingDisconnect(false); setFocusTarget("disconnect"); }} disabled={busy !== null}>Cancelar</button>
        </div>
      ) : null}

      <LiveRegion kind="status">
        {notice?.kind === "status" ? <p className="calendar-settings__notice calendar-settings__notice--status">{notice.text}</p> : null}
      </LiveRegion>
      <LiveRegion kind="alert">
        {notice?.kind === "alert" ? <p className="calendar-settings__notice calendar-settings__notice--alert">{notice.text}</p> : null}
      </LiveRegion>
      {notice?.recheck === true ? (
        <button className="button button--quiet" type="button" onClick={recheck} disabled={busy !== null}>Comprobar de nuevo</button>
      ) : null}

      {!connected ? null : (
        <div className="calendar-settings__selection">
          <h4>Calendarios</h4>
          <p id={explanationId} className="calendar-settings__explanation">
            La escritura se aprueba en dos pasos: primero guarda la lectura de un calendario y después, en un segundo guardado, habilita «Proponer cambios». Solo es posible si Google te da rol de editor o propietario en ese calendario. Aun así, cada cambio concreto necesita tu confirmación explícita.
          </p>
          {rows.length === 0 ? <p className="calendar-settings__fact">Todavía no hay calendarios seleccionados.</p> : rows.map((row, index) => {
            const flags = draft.get(row.calendarRef) ?? offFlags;
            const roleAllowsWrite = canWriteRole(row);
            const readSaved = savedRead.has(row.calendarRef);
            const hintId = `${headingId}-row-${index}-hint`;
            const hint = !roleAllowsWrite
              ? `Tu rol es ${roleLabels[row.accessRole]}: solo lectura en Google, así que no se puede habilitar la escritura.`
              : !readSaved
                ? "Primero guarda la lectura de este calendario; la escritura se habilita en un segundo guardado."
                : "Puedes habilitar propuestas de cambio; cada una requiere tu confirmación.";
            return (
              <fieldset key={row.calendarRef} className="calendar-settings__row" data-primary={row.isPrimary}>
                <legend>{row.isPrimary ? `${row.displayName} (calendario principal)` : row.displayName}</legend>
                <p className="calendar-settings__fact">Rol en Google: {roleLabels[row.accessRole]}</p>
                <label className="calendar-settings__toggle">
                  <input type="checkbox" aria-label={`Leer ${row.displayName}`} checked={flags.readEnabled} disabled={busy !== null} onChange={(event) => setFlag(row.calendarRef, { readEnabled: event.target.checked })} />
                  <span aria-hidden="true">Leer</span>
                </label>
                <label className="calendar-settings__toggle">
                  <input type="checkbox" aria-label={`Proponer cambios en ${row.displayName}`} aria-describedby={`${hintId} ${explanationId}`} checked={effectiveWrite(row, flags)} disabled={busy !== null || !roleAllowsWrite || !readSaved || !flags.readEnabled} onChange={(event) => setFlag(row.calendarRef, { writeEnabled: event.target.checked })} />
                  <span aria-hidden="true">Proponer cambios</span>
                </label>
                <p id={hintId} className="calendar-settings__hint">{hint}</p>
              </fieldset>
            );
          })}
          <div className="calendar-settings__actions">
            <button className="button" type="button" onClick={() => { void save(); }} disabled={busy !== null || rows.length === 0}>{busy === "save" ? "Guardando…" : "Guardar selección"}</button>
            <button className="button button--quiet" type="button" onClick={() => { void discover(); }} disabled={busy !== null}>{busy === "discover" ? "Buscando…" : "Elegir otros calendarios"}</button>
          </div>
        </div>
      )}
    </section>
  );
}
