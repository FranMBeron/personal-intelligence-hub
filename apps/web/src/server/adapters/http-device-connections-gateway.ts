import "server-only";

import {
  DeviceConnectionIdSchema,
  DeviceConnectionReconnectResultSchema,
  DeviceConnectionStatusSchema,
  type DeviceConnectionReconnectResult,
  type DeviceConnectionStatus,
} from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";
import type { DeviceConnectionsGateway } from "../ports/device-connections-gateway";
import type { ConnectorsHttp } from "./connectors-http";

const connectionPath = (connectionId: string): string =>
  "/v1/device-connections/" + DeviceConnectionIdSchema.parse(connectionId);

export class HttpDeviceConnectionsGateway implements DeviceConnectionsGateway {
  constructor(private readonly http: Pick<ConnectorsHttp, "json">) {}

  async status(context: RequestContext, connectionId: string, signal?: AbortSignal): Promise<DeviceConnectionStatus> {
    const path = connectionPath(connectionId);
    return this.http.json(context, { path, method: "GET", schema: DeviceConnectionStatusSchema, scope: "devices:read", signal });
  }

  async reconnect(context: RequestContext, connectionId: string, signal?: AbortSignal): Promise<DeviceConnectionReconnectResult> {
    const path = connectionPath(connectionId) + "/reconnect";
    return this.http.json(context, {
      path, method: "POST", schema: DeviceConnectionReconnectResultSchema, scope: "devices:write", signal,
    });
  }
}
