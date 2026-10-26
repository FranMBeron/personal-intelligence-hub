import "server-only";

import type { DeviceConnectionReconnectResult, DeviceConnectionStatus } from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";

/** Only a configured connection id and a fixed operation ever leave the BFF. */
export interface DeviceConnectionsGateway {
  status(context: RequestContext, connectionId: string, signal?: AbortSignal): Promise<DeviceConnectionStatus>;
  reconnect(context: RequestContext, connectionId: string, signal?: AbortSignal): Promise<DeviceConnectionReconnectResult>;
}
