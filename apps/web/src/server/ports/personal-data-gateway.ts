import "server-only";

import type { Snapshot } from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";

export type SourceHealth = Readonly<{
  status: "available" | "unavailable" | "not_configured";
  checkedAt: string;
}>;

export interface PersonalDataGateway {
  health(context?: RequestContext): Promise<SourceHealth>;
  snapshot(context: RequestContext): Promise<Snapshot>;
}
