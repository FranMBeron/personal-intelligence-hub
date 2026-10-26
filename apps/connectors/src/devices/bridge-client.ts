import {
  DeviceConnectionReasonCodeSchema,
  type DeviceConnectionAction,
  type DeviceConnectionReasonCode,
  type DeviceConnectionState,
} from "@personal-intelligence-hub/contracts";
import { createConnection, type Socket } from "node:net";
import { z } from "zod";

/** Validated, content-free bridge outcome. Bridge text never survives this mapping. */
export type DeviceBridgeOutcome = Readonly<{
  state: DeviceConnectionState;
  reasonCode: DeviceConnectionReasonCode | null;
  action?: DeviceConnectionAction;
  authenticatedAt?: string;
  retryAfterSeconds?: number;
}>;

export type DeviceBridgeErrorCode =
  | "bridge_unreachable"
  | "bridge_timeout"
  | "bridge_response_invalid"
  | "bridge_request_invalid";

/** Closed failure codes; messages are the code itself and never include bridge output or paths. */
export class DeviceBridgeError extends Error {
  readonly code: DeviceBridgeErrorCode;

  constructor(code: DeviceBridgeErrorCode) {
    super(code);
    this.name = "DeviceBridgeError";
    this.code = code;
  }
}

export interface DeviceBridgeClient {
  status(): Promise<DeviceBridgeOutcome>;
  reconnect(actor: string): Promise<DeviceBridgeOutcome>;
}

export type UnixDeviceBridgeClientOptions = Readonly<{
  socketPath: string;
  statusTimeoutMs?: number;
  reconnectTimeoutMs?: number;
  maxResponseBytes?: number;
}>;

export const DEFAULT_STATUS_TIMEOUT_MS = 5_000;
/** The bridge bounds a reconnect at roughly 50 seconds; this leaves headroom for its reply. */
export const DEFAULT_RECONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4_096;
const MAX_REQUEST_BYTES = 256;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const ACTOR_LABEL = /^[a-z][a-z0-9_-]{0,62}$/u;

const BridgeResponseSchema = z.object({
  status: z.enum(["connecting", "connected", "unavailable", "failed"]),
  reason: z.string().max(512).nullable(),
  action: z.string().max(64).optional(),
  authenticated_at: z.string().datetime({ offset: true }).optional(),
  retry_after_seconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<DeviceConnectionAction>(["wake_device"]);

const reasonCode = (reason: string | null): DeviceConnectionReasonCode | null => {
  if (reason === null) return null;
  const known = DeviceConnectionReasonCodeSchema.safeParse(reason);
  return known.success ? known.data : "unspecified";
};

const toOutcome = (raw: z.infer<typeof BridgeResponseSchema>): DeviceBridgeOutcome => {
  const outcome: {
    -readonly [K in keyof DeviceBridgeOutcome]: DeviceBridgeOutcome[K];
  } = { state: raw.status, reasonCode: reasonCode(raw.reason) };
  if (raw.status === "connected") {
    if (raw.authenticated_at !== undefined) outcome.authenticatedAt = raw.authenticated_at;
    return Object.freeze(outcome);
  }
  if (raw.action !== undefined && KNOWN_ACTIONS.has(raw.action)) {
    outcome.action = raw.action as DeviceConnectionAction;
  }
  if (raw.retry_after_seconds !== undefined && raw.retry_after_seconds > 0) {
    outcome.retryAfterSeconds = Math.min(raw.retry_after_seconds, MAX_RETRY_AFTER_SECONDS);
  }
  return Object.freeze(outcome);
};

const parseLine = (line: string): DeviceBridgeOutcome => {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    throw new DeviceBridgeError("bridge_response_invalid");
  }
  const parsed = BridgeResponseSchema.safeParse(payload);
  if (!parsed.success) throw new DeviceBridgeError("bridge_response_invalid");
  return toOutcome(parsed.data);
};

const exchange = (
  socketPath: string,
  request: string,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<DeviceBridgeOutcome> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let length = 0;
  let connected = false;
  let settled = false;
  // Listeners are attached below in the same tick, before any socket event can fire.
  const socket: Socket = createConnection({ path: socketPath });

  const finish = (result: () => DeviceBridgeOutcome): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    try {
      resolve(result());
    } catch (error) {
      reject(error instanceof DeviceBridgeError ? error : new DeviceBridgeError("bridge_response_invalid"));
    }
  };
  const fail = (code: DeviceBridgeErrorCode): void => finish(() => { throw new DeviceBridgeError(code); });
  const timer = setTimeout(() => fail("bridge_timeout"), timeoutMs);

  socket.on("connect", () => {
    connected = true;
    socket.write(request);
  });
  socket.on("data", (chunk: Buffer) => {
    const newline = chunk.indexOf(0x0a);
    const usable = newline >= 0 ? chunk.subarray(0, newline) : chunk;
    length += usable.byteLength;
    if (length > maxResponseBytes) {
      fail("bridge_response_invalid");
      return;
    }
    chunks.push(usable);
    if (newline >= 0) finish(() => parseLine(Buffer.concat(chunks, length).toString("utf8")));
  });
  socket.on("end", () => {
    if (length === 0) {
      fail("bridge_response_invalid");
      return;
    }
    finish(() => parseLine(Buffer.concat(chunks, length).toString("utf8")));
  });
  socket.on("error", () => fail(connected ? "bridge_response_invalid" : "bridge_unreachable"));
  socket.on("close", () => fail(connected ? "bridge_response_invalid" : "bridge_unreachable"));
});

const positive = (value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error("Bridge client limits must be positive integers");
  return resolved;
};

/**
 * Speaks the bridge protocol: one newline-terminated JSON request per connection and one JSON line
 * back. Requests are built only from fixed operations and a validated actor label.
 */
export const createUnixDeviceBridgeClient = (options: UnixDeviceBridgeClientOptions): DeviceBridgeClient => {
  const statusTimeoutMs = positive(options.statusTimeoutMs, DEFAULT_STATUS_TIMEOUT_MS);
  const reconnectTimeoutMs = positive(options.reconnectTimeoutMs, DEFAULT_RECONNECT_TIMEOUT_MS);
  const maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  const send = (payload: Readonly<Record<string, string>>, timeoutMs: number): Promise<DeviceBridgeOutcome> => {
    const request = JSON.stringify(payload) + "\n";
    if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) {
      return Promise.reject(new DeviceBridgeError("bridge_request_invalid"));
    }
    return exchange(options.socketPath, request, timeoutMs, maxResponseBytes);
  };
  return Object.freeze({
    status: () => send({ op: "status" }, statusTimeoutMs),
    reconnect: (actor: string) => {
      if (typeof actor !== "string" || !ACTOR_LABEL.test(actor)) {
        return Promise.reject(new DeviceBridgeError("bridge_request_invalid"));
      }
      return send({ op: "reconnect", actor }, reconnectTimeoutMs);
    },
  });
};
