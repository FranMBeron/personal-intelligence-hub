import type { AgentSummary } from "@personal-intelligence-hub/contracts";

/** Outcome of reading the connectors profile registry; failure is never an empty roster. */
export type RosterResult =
  | Readonly<{ state: "not_configured" }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "available"; agents: readonly AgentSummary[] }>;

export type AgentFilter = "all" | "active" | "attention";

export const AGENT_FILTERS: readonly Readonly<{ id: AgentFilter; label: string }>[] = [
  { id: "all", label: "Todos" },
  { id: "active", label: "En actividad" },
  { id: "attention", label: "Con alertas" },
];

export type MetricId = "available" | "working" | "ready" | "attention";

/** `null` means the source did not answer; it is never rendered as zero. */
export type AgentCounts = Readonly<{
  total: number | null;
  available: number | null;
  working: number | null;
  ready: number | null;
  attention: number | null;
}>;

export type AgentMetric = Readonly<{
  id: MetricId;
  label: string;
  value: string;
  detail: string;
  tone: "neutral" | "positive" | "accent" | "warning" | "danger";
}>;

export type AgentActivity = Readonly<{
  agentId: string;
  displayName: string;
  kind: "working" | "result" | "attention";
  label: string;
  checkedAt: string;
}>;

export type AgentsView = Readonly<{
  state: RosterResult["state"];
  agents: readonly AgentSummary[];
  counts: AgentCounts;
  metrics: readonly AgentMetric[];
  activity: readonly AgentActivity[];
}>;

type MetricRule = Readonly<{
  id: MetricId;
  label: string;
  matches: (agent: AgentSummary) => boolean;
  unknown: (agent: AgentSummary) => boolean;
  none: string;
  some: (count: number) => string;
  tone: AgentMetric["tone"];
}>;

const RULES: readonly MetricRule[] = [
  {
    id: "available", label: "Disponibles", tone: "positive",
    matches: (agent) => agent.availability === "online",
    unknown: (agent) => agent.availability === "unknown",
    none: "Ningún agente conectado",
    some: (count) => (count === 1 ? "1 agente conectado" : `${count} agentes conectados`),
  },
  {
    id: "working", label: "Trabajando ahora", tone: "accent",
    matches: (agent) => agent.execution === "working",
    unknown: (agent) => agent.execution === "unknown",
    none: "Sin trabajos en curso",
    some: () => "Actividad en curso",
  },
  {
    // Only an explicit `ready` result counts; `waiting` execution is never a result.
    id: "ready", label: "Resultados listos", tone: "positive",
    matches: (agent) => agent.result === "ready",
    unknown: (agent) => agent.result === "unknown",
    none: "Sin resultados pendientes",
    some: () => "Revisión disponible",
  },
  {
    id: "attention", label: "Requieren atención", tone: "danger",
    matches: (agent) => agent.attention === "required",
    unknown: (agent) => agent.attention === "unknown",
    none: "Sin bloqueos",
    some: () => "Revisar estado",
  },
];

const unavailableDetail = (state: "not_configured" | "unavailable"): string =>
  state === "not_configured" ? "Hermes no configurado" : "El roster no respondió";

export const buildAgentsView = (result: RosterResult): AgentsView => {
  if (result.state !== "available") {
    return {
      state: result.state,
      agents: [],
      counts: { total: null, available: null, working: null, ready: null, attention: null },
      metrics: RULES.map((rule) => ({
        id: rule.id,
        label: rule.label,
        value: "No disponible",
        detail: unavailableDetail(result.state),
        tone: "neutral",
      })),
      activity: [],
    };
  }
  const { agents } = result;
  const count = (rule: MetricRule) => agents.filter(rule.matches).length;
  const metrics = RULES.map((rule): AgentMetric => {
    const value = count(rule);
    const unknown = agents.filter(rule.unknown).length;
    const base = value === 0 ? rule.none : rule.some(value);
    return {
      id: rule.id,
      label: rule.label,
      value: String(value),
      detail: unknown === 0 ? base : `${base} · ${unknown} sin datos`,
      tone: value === 0 ? "neutral" : rule.tone,
    };
  });
  const [available, working, ready, attention] = RULES.map(count) as [number, number, number, number];
  return {
    state: "available",
    agents,
    counts: { total: agents.length, available, working, ready, attention },
    metrics,
    activity: buildActivity(agents),
  };
};

const activityOf = (agent: AgentSummary): AgentActivity | null => {
  const kind: AgentActivity["kind"] | null =
    agent.result === "ready" ? "result"
      : agent.execution === "working" ? "working"
        : agent.attention === "required" ? "attention"
          : null;
  if (kind === null) return null;
  const label = kind === "result" ? "Resultado listo" : kind === "working" ? "En curso" : "Requiere atención";
  return { agentId: agent.id, displayName: agent.displayName, kind, label, checkedAt: agent.checkedAt };
};

/** Real reported state ordered by its own check time; nothing is synthesized. */
const buildActivity = (agents: readonly AgentSummary[]): readonly AgentActivity[] =>
  agents
    .map(activityOf)
    .filter((item): item is AgentActivity => item !== null)
    .toSorted((left, right) => Date.parse(right.checkedAt) - Date.parse(left.checkedAt));

export const matchesFilter = (agent: AgentSummary, filter: AgentFilter): boolean =>
  filter === "all" ||
  (filter === "active" ? agent.execution === "working" : agent.attention === "required");

export const filterAgents = (agents: readonly AgentSummary[], filter: AgentFilter): readonly AgentSummary[] =>
  filter === "all" ? agents : agents.filter((agent) => matchesFilter(agent, filter));

export const parseAgentFilter = (value: string | null): AgentFilter =>
  value === "active" || value === "attention" ? value : "all";
