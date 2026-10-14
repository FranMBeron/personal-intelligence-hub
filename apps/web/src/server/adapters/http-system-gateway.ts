import "server-only";

import { SystemStatusSchema, type SystemStatus } from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";
import type { SystemGateway } from "../ports/system-gateway";
import type { ConnectorsHttp } from "./connectors-http";

export class HttpSystemGateway implements SystemGateway {
  constructor(private readonly http: Pick<ConnectorsHttp, "json">) {}

  status(context: RequestContext, signal?: AbortSignal): Promise<SystemStatus> {
    return this.http.json(context, {
      path: "/v1/system/status",
      method: "GET",
      schema: SystemStatusSchema,
      scope: "system:read",
      signal,
    });
  }
}
