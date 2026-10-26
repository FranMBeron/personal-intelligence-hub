import {
  AgentSummarySchema,
  CalendarSourceStatusSchema,
  SystemStatusSchema,
} from "@personal-intelligence-hub/contracts";
import { z } from "zod";

import { BffRequestError, bffJson, type Fetcher } from "../../_lib/bff-request";
import type { Loadable, SystemSnapshot } from "./system-view";

const AgentListSchema = z.array(AgentSummarySchema);

const settle = async <T>(operation: Promise<T>): Promise<Loadable<T>> => {
  try {
    return { state: "loaded", value: await operation };
  } catch {
    return { state: "unavailable" };
  }
};

/** The BFF answers 501 only when Calendar is not configured for this deployment; any other failure is unavailability. */
const settleCalendar = async <T>(operation: Promise<T>): Promise<Loadable<T>> => {
  try {
    return { state: "loaded", value: await operation };
  } catch (error) {
    return isNotConfigured(error) ? { state: "not_configured" } : { state: "unavailable" };
  }
};

const isNotConfigured = (error: unknown): boolean =>
  error instanceof BffRequestError && error.status === 501 && error.code === "dependency_unavailable";

export type SystemStatusLoader = Readonly<{ load(signal?: AbortSignal): Promise<SystemSnapshot> }>;

/** Reads each status source independently; one failing source never hides the others. */
export class SystemStatusClient implements SystemStatusLoader {
  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  async load(signal?: AbortSignal): Promise<SystemSnapshot> {
    const [connectors, agents, calendar] = await Promise.all([
      settle(bffJson(this.fetcher, "/api/ui/v1/system/status", SystemStatusSchema, { signal })),
      settle(bffJson(this.fetcher, "/api/ui/v1/agents", AgentListSchema, { signal })),
      settleCalendar(bffJson(this.fetcher, "/api/ui/v1/calendar/status", CalendarSourceStatusSchema, { signal })),
    ]);
    return { connectors, agents, calendar };
  }
}
