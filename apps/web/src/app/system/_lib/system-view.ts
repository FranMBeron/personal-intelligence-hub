import type {
  AgentSummary,
  CalendarSourceStatus,
  SourceState,
  SourceStatus,
  SystemStatus,
} from "@personal-intelligence-hub/contracts";

/** One independently fetched input. `not_configured` comes from deployment configuration, never from a failed request. */
export type Loadable<T> =
  | Readonly<{ state: "loaded"; value: T }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "not_configured" }>;

export type SystemSnapshot = Readonly<{
  connectors: Loadable<SystemStatus>;
  agents: Loadable<readonly AgentSummary[]>;
  calendar: Loadable<CalendarSourceStatus>;
}>;

export type StatusTone = "positive" | "warning" | "danger" | "neutral";

export type SourceCardView = Readonly<{
  key: string;
  title: string;
  state: SourceState;
  stateLabel: string;
  tone: StatusTone;
  /** True only when the source itself reported a fresh, successful check. */
  verified: boolean;
  stale: boolean;
  checkedAt: string | null;
  ageLabel: string | null;
  lastSuccessAt: string | null;
  reason: string | null;
  detail: string | null;
  capabilities: readonly string[];
}>;

export type TelemetryView = Readonly<{ key: string; label: string; value: number | null; unit: string }>;

export type SystemView = Readonly<{
  tone: StatusTone;
  label: string;
  detail: string;
  verified: boolean;
  /** Oldest check among the reported sources: the most conservative freshness claim. */
  checkedAt: string | null;
  cards: readonly SourceCardView[];
  telemetry: readonly TelemetryView[];
}>;

export const stateLabels: Record<SourceState, string> = {
  available: "Disponible",
  degraded: "Degradado",
  requires_reauthorization: "Requiere volver a autorizar",
  requires_attention: "Requiere atención",
  unavailable: "No disponible",
  not_configured: "No configurado",
};

const stateTones: Record<SourceState, StatusTone> = {
  available: "positive",
  degraded: "warning",
  requires_reauthorization: "warning",
  requires_attention: "warning",
  unavailable: "danger",
  not_configured: "neutral",
};

const sourceTitles: Readonly<Record<string, string>> = {
  hermes: "Hermes",
  calendar: "Google Calendar",
  preferences: "Preferencias",
};

const reasonLabels: Readonly<Record<string, string>> = {
  probe_failed: "La comprobación del servicio falló.",
  provider_temporarily_unavailable: "El proveedor no respondió temporalmente.",
  reauthorization_required: "Hay que autorizar de nuevo el acceso desde el navegador.",
  provider_permission_denied: "El proveedor rechazó el permiso solicitado.",
  calendar_selection_required: "Falta elegir qué calendarios leer.",
};

const calendarReasonFallback: Partial<Record<SourceState, string>> = {
  requires_reauthorization: "Hay que autorizar de nuevo el acceso desde el navegador.",
};

export const reasonLabel = (code: string | undefined): string | null =>
  code === undefined ? null : reasonLabels[code] ?? `Motivo informado por el servicio: ${code}`;

export const ageLabel = (checkedAt: string, now: Date): string => {
  const minutes = Math.floor((now.getTime() - Date.parse(checkedAt)) / 60_000);
  if (minutes < 1) return "hace menos de 1 min";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} días`;
};

type CardInput = Readonly<{
  key: string;
  title: string;
  state: SourceState;
  stale: boolean;
  checkedAt: string | null;
  lastSuccessAt?: string | undefined;
  reason: string | null;
  detail?: string | null;
  capabilities?: readonly string[];
  /** The request itself is the evidence (no source timestamp), e.g. the connectors service answering. */
  answeredRequest?: boolean;
}>;

const card = (input: CardInput, now: Date): SourceCardView => {
  const verified = input.state === "available" && !input.stale && (input.checkedAt !== null || input.answeredRequest === true);
  const staleAvailable = input.state === "available" && input.stale;
  return {
    key: input.key,
    title: input.title,
    state: input.state,
    stateLabel: staleAvailable ? "Disponible, datos sin actualizar" : stateLabels[input.state],
    tone: staleAvailable ? "warning" : stateTones[input.state],
    verified,
    stale: input.stale,
    checkedAt: input.checkedAt,
    ageLabel: input.checkedAt === null ? null : ageLabel(input.checkedAt, now),
    lastSuccessAt: input.lastSuccessAt ?? null,
    reason: input.reason,
    detail: input.detail ?? null,
    capabilities: input.capabilities ?? [],
  };
};

const sourceCard = (source: SourceStatus, now: Date): SourceCardView => card({
  key: `source:${source.id}`,
  title: sourceTitles[source.id] ?? source.id,
  state: source.state,
  stale: source.stale,
  checkedAt: source.checkedAt,
  lastSuccessAt: source.lastSuccessAt,
  reason: reasonLabel(source.safeReasonCode),
  capabilities: source.capabilities,
}, now);

const unloadedCard = (key: string, title: string, state: "unavailable" | "not_configured", now: Date): SourceCardView => card({
  key,
  title,
  state,
  stale: false,
  checkedAt: null,
  reason: state === "unavailable" ? "No se obtuvo respuesta en la última consulta." : null,
}, now);

const calendarCard = (status: CalendarSourceStatus, now: Date): SourceCardView => {
  const capabilities = [
    ...(status.canRead ? ["Lectura de agenda"] : []),
    ...(status.canProposeChanges ? ["Propuestas de cambio con confirmación"] : []),
  ];
  const calendars = status.primaryCalendarConfigured
    ? `Calendario principal configurado${status.additionalCalendarCount === 0 ? "" : ` · ${status.additionalCalendarCount} adicional${status.additionalCalendarCount === 1 ? "" : "es"}`}`
    : null;
  return card({
    key: "calendar",
    title: "Google Calendar",
    state: status.state,
    stale: status.stale,
    checkedAt: status.checkedAt,
    lastSuccessAt: status.lastSuccessAt,
    reason: reasonLabel(status.safeReasonCode) ?? calendarReasonFallback[status.state] ?? null,
    detail: calendars,
    capabilities,
  }, now);
};

const agentsCard = (agents: readonly AgentSummary[], now: Date): SourceCardView => {
  if (agents.length === 0) {
    return card({ key: "agents", title: "Agentes", state: "not_configured", stale: false, checkedAt: null, reason: null, detail: "No hay perfiles de agente registrados." }, now);
  }
  const online = agents.filter((agent) => agent.availability === "online").length;
  const offline = agents.filter((agent) => agent.availability === "offline").length;
  const unknown = agents.length - online - offline;
  const oldest = agents.map((agent) => agent.checkedAt).toSorted()[0]!;
  const state: SourceState = online === agents.length ? "available" : online === 0 && unknown === 0 ? "unavailable" : "degraded";
  const parts = [`${online} de ${agents.length} en línea`];
  if (offline > 0) parts.push(`${offline} sin respuesta`);
  if (unknown > 0) parts.push(`${unknown} sin verificar`);
  return card({ key: "agents", title: "Agentes", state, stale: false, checkedAt: oldest, reason: null, detail: parts.join(" · ") }, now);
};

const telemetry: readonly TelemetryView[] = [
  { key: "cpu", label: "CPU", value: null, unit: "%" },
  { key: "memory", label: "Memoria", value: null, unit: "%" },
  { key: "backups", label: "Copias de seguridad", value: null, unit: "" },
];

const aggregate = (cards: readonly SourceCardView[]): Pick<SystemView, "tone" | "label" | "detail" | "verified"> => {
  if (cards.some((item) => item.tone === "danger")) {
    return { tone: "danger", label: "Hay servicios sin respuesta", detail: "Cada tarjeta muestra lo que su fuente pudo verificar y cuándo.", verified: false };
  }
  if (cards.some((item) => item.tone === "warning")) {
    return { tone: "warning", label: "Servicios con atención pendiente", detail: "Algún servicio está degradado, requiere autorización o tiene datos sin actualizar.", verified: false };
  }
  const reported = cards.filter((item) => item.key !== "connectors");
  if (reported.length === 0) {
    return { tone: "neutral", label: "Sin fuentes registradas", detail: "El servicio de conectores respondió, pero no informó ninguna fuente.", verified: false };
  }
  if (cards.some((item) => item.state === "not_configured")) {
    return { tone: "neutral", label: "Servicios verificados con fuentes sin configurar", detail: "Las fuentes configuradas respondieron; el resto todavía no está configurado.", verified: false };
  }
  return { tone: "positive", label: "Servicios verificados", detail: "Cada fuente respondió con datos actualizados en su última comprobación.", verified: true };
};

/**
 * Pure projection of independently fetched status evidence. `status === null` means the connectors
 * service could not be read; nothing is inferred from capabilities or from the render clock.
 */
export const buildSystemView = (
  status: SystemStatus | null,
  now: Date,
  related: Readonly<{
    connectors?: "unavailable" | "not_configured";
    agents?: Loadable<readonly AgentSummary[]>;
    calendar?: Loadable<CalendarSourceStatus>;
  }> = {},
): SystemView => {
  const cards: SourceCardView[] = [];
  if (status === null) {
    cards.push(unloadedCard("connectors", "Conectores privados", related.connectors ?? "unavailable", now));
  } else {
    cards.push(card({ key: "connectors", title: "Conectores privados", state: "available", stale: false, checkedAt: null, reason: null, detail: "El servicio respondió a la consulta de estado.", answeredRequest: true }, now));
    const hasDetailedCalendar = related.calendar !== undefined;
    for (const source of status.sources) {
      if (hasDetailedCalendar && source.id === "calendar") continue;
      cards.push(sourceCard(source, now));
    }
  }
  if (related.agents !== undefined) {
    cards.push(related.agents.state === "loaded" ? agentsCard(related.agents.value, now) : unloadedCard("agents", "Agentes", related.agents.state, now));
  }
  if (related.calendar !== undefined) {
    cards.push(related.calendar.state === "loaded" ? calendarCard(related.calendar.value, now) : unloadedCard("calendar", "Google Calendar", related.calendar.state, now));
  }
  const checks = cards.map((item) => item.checkedAt).filter((value): value is string => value !== null).toSorted();
  return { ...aggregate(cards), checkedAt: checks[0] ?? null, cards, telemetry };
};

export const buildSystemViewFromSnapshot = (snapshot: SystemSnapshot, now: Date): SystemView =>
  buildSystemView(snapshot.connectors.state === "loaded" ? snapshot.connectors.value : null, now, {
    ...(snapshot.connectors.state === "loaded" ? {} : { connectors: snapshot.connectors.state }),
    agents: snapshot.agents,
    calendar: snapshot.calendar,
  });
