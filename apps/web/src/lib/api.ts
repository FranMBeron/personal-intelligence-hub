import "server-only";

import { serverConfig } from "../config/server";

export type ApiHealth = "available" | "unavailable";

export async function getApiHealth(): Promise<ApiHealth> {
  try {
    const response = await fetch(
      new URL("/health/live", serverConfig.apiInternalUrl),
      {
        cache: "no-store",
        signal: AbortSignal.timeout(2_000),
      },
    );

    return response.ok ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}
