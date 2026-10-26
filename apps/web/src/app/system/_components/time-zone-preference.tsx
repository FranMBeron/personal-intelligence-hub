"use client";

import type { UserPreferences } from "@personal-intelligence-hub/contracts";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";

import { BffRequestError } from "../../_lib/bff-request";
import { isValidTimeZone } from "../../_lib/time-format";
import { PreferencesClient } from "../_lib/preferences-client";
import { LiveRegion } from "./live-region";
import "./system.css";

type Notice = Readonly<{ kind: "status" | "alert"; text: string }>;

const supportedZones = (): readonly string[] => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};

/**
 * Edits the user's IANA time zone through the versioned preferences route. It sends only
 * `{timeZone, expectedVersion}` and, on a version conflict, reloads the stored value instead of overwriting it.
 */
export function TimeZonePreference({ initial, client, onSaved }: Readonly<{
  initial: UserPreferences;
  client?: Pick<PreferencesClient, "get" | "update">;
  onSaved?: (preferences: UserPreferences) => void;
}>) {
  const preferences = useRef(client ?? new PreferencesClient()).current;
  const [current, setCurrent] = useState(initial);
  const [draft, setDraft] = useState(initial.timeZone);
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const listId = useId();
  const zones = useMemo(supportedZones, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    const timeZone = draft.trim();
    if (!isValidTimeZone(timeZone)) {
      setInvalid(true);
      setNotice({ kind: "alert", text: "Escribe una zona horaria IANA válida, por ejemplo Europe/Madrid." });
      inputRef.current?.focus();
      return;
    }
    setInvalid(false);
    busy.current = true;
    setPending(true);
    setNotice(null);
    try {
      const saved = await preferences.update({ timeZone, expectedVersion: current.version });
      setCurrent(saved);
      setDraft(saved.timeZone);
      setNotice({ kind: "status", text: `Zona horaria guardada: ${saved.timeZone}.` });
      onSaved?.(saved);
    } catch (error) {
      if (error instanceof BffRequestError && error.status === 409) {
        try {
          const latest = await preferences.get();
          setCurrent(latest);
          setDraft(latest.timeZone);
          setNotice({ kind: "alert", text: `La zona horaria se cambió desde otro dispositivo. Se cargó el valor guardado (${latest.timeZone}); revísalo y guarda de nuevo si quieres cambiarlo.` });
        } catch {
          setNotice({ kind: "alert", text: "La zona horaria se cambió desde otro dispositivo y no se pudo cargar el valor actual. Recarga la página antes de guardar." });
        }
      } else {
        setNotice({ kind: "alert", text: "No se pudo guardar la zona horaria. El valor guardado no cambió; inténtalo de nuevo." });
      }
      inputRef.current?.focus();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <form className="time-zone-preference" aria-label="Preferencia de zona horaria" onSubmit={(event) => { void submit(event); }} noValidate>
      <label htmlFor={inputId}>Zona horaria</label>
      <p id={hintId} className="time-zone-preference__hint">
        Zona actual: <strong>{current.timeZone}</strong>. Se usa para el día, los saludos y la agenda en web y escritorio.
      </p>
      <div className="time-zone-preference__row">
        <input
          ref={inputRef}
          id={inputId}
          name="timeZone"
          type="text"
          autoComplete="off"
          spellCheck={false}
          list={zones.length === 0 ? undefined : listId}
          value={draft}
          aria-describedby={hintId}
          aria-invalid={invalid}
          onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
        />
        <button className="button" type="submit" disabled={pending}>{pending ? "Guardando…" : "Guardar zona horaria"}</button>
      </div>
      {zones.length === 0 ? null : (
        <datalist id={listId}>{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
      )}
      <LiveRegion kind="status">
        {notice?.kind === "status" ? <p className="time-zone-preference__notice time-zone-preference__notice--status">{notice.text}</p> : null}
      </LiveRegion>
      <LiveRegion kind="alert">
        {notice?.kind === "alert" ? <p className="time-zone-preference__notice time-zone-preference__notice--alert">{notice.text}</p> : null}
      </LiveRegion>
    </form>
  );
}
