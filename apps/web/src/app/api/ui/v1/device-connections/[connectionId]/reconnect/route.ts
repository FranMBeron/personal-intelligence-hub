import { deviceConnectionsGateway } from "../../../../../../../server/device-connections-runtime";
import { serverRuntime } from "../../../../../../../server/runtime";
import { createDeviceConnectionReconnectHandler } from "../../../_lib/device-connection-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A reconnect can take up to about a minute; keep the handler alive past the default budget. */
export const maxDuration = 90;

export const POST = createDeviceConnectionReconnectHandler(deviceConnectionsGateway, serverRuntime.requestPolicy);
