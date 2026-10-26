"use client";

import { useEffect, useState } from "react";
import {
  DeviceConnectionStatusSchema,
  type DeviceConnectionStatus as Status,
} from "@personal-intelligence-hub/contracts";

import { StatusBadge } from "./status-badge";

type Tone = "neutral" | "positive" | "warning" | "danger" | "accent";

const STATE_LABELS: Readonly<Record<Status["state"], Readonly<{ label: string; tone: Tone }>>> = {
  connected: { label: "Conectada", tone: "positive" },
  connecting: { label: "Conectando…", tone: "accent" },
  unavailable: { label: "No disponible", tone: "warning" },
  failed: { label: "Error de conexión", tone: "danger" },
};

const MESSAGES = {
  connected: "Conexión confirmada por el puente del dispositivo.",
  wake: "El dispositivo no responde. Despierta el dispositivo (por ejemplo, tócalo o súbete a él) y vuelve a intentarlo.",
  unavailable: "El dispositivo no está disponible. Comprueba que esté cerca y encendido, y vuelve a intentarlo.",
  inProgress: "La reconexión sigue en curso. Consulta el estado de nuevo en unos segundos.",
  forbidden: "No tienes permiso para reconectar este dispositivo.",
  timeout: "La reconexión tardó demasiado. Vuelve a intentarlo.",
  authentication: "El dispositivo rechazó la autenticación. Revisa el emparejamiento y vuelve a intentarlo.",
  failed: "No se pudo reconectar el dispositivo. Vuelve a intentarlo.",
  bridge: "No se pudo contactar con el puente del dispositivo. Vuelve a intentarlo más tarde.",
  tooMany: "Demasiados intentos. Espera un momento y vuelve a intentarlo.",
} as const;

type Outcome = Readonly<{ kind: "success" | "error"; text: string }>;

/** Maps a validated status to a message; only a bridge-confirmed "connected" is a success. */
export const deviceConnectionMessage = (status: Status): Outcome => {
  if (status.state === "connected") return { kind: "success", text: MESSAGES.connected };
  if (status.retryAfterSeconds !== undefined) {
    return { kind: "error", text: `Espera ${status.retryAfterSeconds} s antes de volver a intentarlo.` };
  }
  if (status.reasonCode === "actor_not_allowed") return { kind: "error", text: MESSAGES.forbidden };
  if (status.action === "wake_device") return { kind: "error", text: MESSAGES.wake };
  if (status.state === "connecting" || status.reasonCode === "in_progress") return { kind: "error", text: MESSAGES.inProgress };
  if (status.reasonCode === "cooldown") return { kind: "error", text: MESSAGES.tooMany };
  if (status.reasonCode === "timeout") return { kind: "error", text: MESSAGES.timeout };
  if (status.reasonCode === "authentication_failed") return { kind: "error", text: MESSAGES.authentication };
  if (status.state === "unavailable") return { kind: "error", text: MESSAGES.unavailable };
  return { kind: "error", text: MESSAGES.failed };
};

const httpFailure = (status: number): Outcome => {
  if (status === 401 || status === 403) return { kind: "error", text: MESSAGES.forbidden };
  if (status === 429) return { kind: "error", text: MESSAGES.tooMany };
  return { kind: "error", text: MESSAGES.bridge };
};

class HttpFailure extends Error {
  constructor(readonly status: number) {
    super("Device connection request failed.");
  }
}

const basePath = (connectionId: string): string => `/api/ui/v1/device-connections/${encodeURIComponent(connectionId)}`;

const request = async (fetcher: typeof fetch, path: string, init: RequestInit): Promise<Status> => {
  const response = await fetcher(path, { cache: "no-store", credentials: "same-origin", redirect: "error", ...init });
  if (!response.ok) throw new HttpFailure(response.status);
  // Anything that is not a valid contract status is treated as a failure, never as success.
  return DeviceConnectionStatusSchema.parse(await response.json());
};

const failureOutcome = (error: unknown): Outcome =>
  error instanceof HttpFailure ? httpFailure(error.status) : { kind: "error", text: MESSAGES.bridge };

export function DeviceConnectionStatus({
  connectionId,
  initialStatus = null,
  fetcher = fetch,
}: Readonly<{
  connectionId: string;
  initialStatus?: Status | null;
  fetcher?: typeof fetch;
}>) {
  const [status, setStatus] = useState<Status | null>(initialStatus);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (initialStatus !== null) return undefined;
    const controller = new AbortController();
    request(fetcher, basePath(connectionId), { signal: controller.signal })
      .then(setStatus)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setOutcome(failureOutcome(error));
      });
    return () => controller.abort();
  }, [connectionId, fetcher, initialStatus]);

  const reconnect = async () => {
    if (running) return;
    setRunning(true);
    setOutcome(null);
    try {
      const result = await request(fetcher, `${basePath(connectionId)}/reconnect`, { method: "POST" });
      setStatus(result);
      setOutcome(deviceConnectionMessage(result));
    } catch (error) {
      setOutcome(failureOutcome(error));
    } finally {
      setRunning(false);
    }
  };

  const state = status === null ? null : STATE_LABELS[status.state];

  return (
    <section className="device-connection" aria-label="Conexión del dispositivo">
      <div className="device-connection__summary">
        <span className="device-connection__label">{status?.label ?? "Dispositivo"}</span>
        {state === null
          ? <StatusBadge>Estado desconocido</StatusBadge>
          : <StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
      </div>
      <button type="button" onClick={() => { void reconnect(); }} disabled={running} aria-busy={running}>
        {running ? "Reconectando…" : "Reconectar"}
      </button>
      {outcome !== null && (
        <p className="device-connection__message" role={outcome.kind === "error" ? "alert" : "status"}>
          {outcome.text}
        </p>
      )}
    </section>
  );
}
