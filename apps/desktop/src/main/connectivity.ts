import type { ConnectionState } from "../shared/contracts.js";

export async function checkServer(
  origin: URL,
  dependencies: { fetch: typeof fetch; timeoutMs: number } = { fetch: globalThis.fetch, timeoutMs: 5000 },
): Promise<ConnectionState> {
  const serverOrigin = origin.origin;
  const unavailable = (reason: string): ConnectionState => ({ kind: "unavailable", origin: serverOrigin, reason });
  const signal = AbortSignal.timeout(dependencies.timeoutMs);
  let response: Response;
  try {
    response = await dependencies.fetch(new URL("/health", origin), {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json" },
    });
  } catch {
    return unavailable(signal.aborted ? "timeout" : "network-error");
  }
  if (!response.ok) return unavailable("http-error");
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" || payload === null || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 || !("status" in payload) || payload.status !== "ok"
    ) {
      return unavailable("invalid-response");
    }
  } catch {
    return unavailable(signal.aborted ? "timeout" : "invalid-response");
  }
  return { kind: "connected", origin: serverOrigin };
}
