import "server-only";

import { serverConfig } from "../config/server";
import { ConnectorsHttp } from "./adapters/connectors-http";
import { HttpDeviceConnectionsGateway } from "./adapters/http-device-connections-gateway";
import type { DeviceConnectionsGateway } from "./ports/device-connections-gateway";

/**
 * A device reconnect may legitimately take about a minute (connectors bounds the bridge at 60 s),
 * so these calls use their own connectors client with a longer, still bounded, timeout.
 */
export const DEVICE_CONNECTIONS_UPSTREAM_TIMEOUT_MS = 70_000;

export const deviceConnectionsGateway: DeviceConnectionsGateway | null = serverConfig.connectors === undefined
  ? null
  : new HttpDeviceConnectionsGateway(new ConnectorsHttp({
    ...serverConfig.connectors,
    timeoutMs: DEVICE_CONNECTIONS_UPSTREAM_TIMEOUT_MS,
    maxUploadBytes: serverConfig.maxUploadBodyBytes,
  }));
