import "server-only";

import type { SystemStatus } from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";

export interface SystemGateway {
  status(context: RequestContext, signal?: AbortSignal): Promise<SystemStatus>;
}
