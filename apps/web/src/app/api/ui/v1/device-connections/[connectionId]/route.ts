import { deviceConnectionsGateway } from "../../../../../../server/device-connections-runtime";
import { serverRuntime } from "../../../../../../server/runtime";
import { createDeviceConnectionStatusHandler } from "../../_lib/device-connection-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createDeviceConnectionStatusHandler(deviceConnectionsGateway, serverRuntime.requestPolicy);
