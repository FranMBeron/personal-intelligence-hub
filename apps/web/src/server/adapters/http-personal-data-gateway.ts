import "server-only";

import { SnapshotSchema, type Snapshot } from "@personal-intelligence-hub/contracts";

import type { RequestContext } from "../context";
import type {
  PersonalDataGateway,
  SourceHealth,
} from "../ports/personal-data-gateway";
import { GatewayError, dependencyUnavailable } from "../problems";

type Options = Readonly<{
  baseUrl: string;
  fetcher?: typeof fetch;
  clock?: () => Date;
}>;

const requestHeaders = (context?: RequestContext): Headers => {
  const headers = new Headers({ accept: "application/json" });
  if (context !== undefined) {
    headers.set("authorization", context.authorization);
    headers.set("x-request-id", context.requestId);
  }
  return headers;
};

export class HttpPersonalDataGateway implements PersonalDataGateway {
  readonly #baseUrl: string;
  readonly #fetcher: typeof fetch;
  readonly #clock: () => Date;

  constructor({ baseUrl, fetcher = fetch, clock = () => new Date() }: Options) {
    this.#baseUrl = baseUrl;
    this.#fetcher = fetcher;
    this.#clock = clock;
  }

  async health(context?: RequestContext): Promise<SourceHealth> {
    let status: SourceHealth["status"] = "unavailable";
    try {
      const response = await this.#fetcher(
        new Request(new URL("/health/live", this.#baseUrl), {
          cache: "no-store",
          headers: requestHeaders(context),
          signal: AbortSignal.timeout(2_000),
        }),
      );
      if (response.ok) status = "available";
    } catch {
      status = "unavailable";
    }
    return { status, checkedAt: this.#clock().toISOString() };
  }

  async snapshot(context: RequestContext): Promise<Snapshot> {
    try {
      const response = await this.#fetcher(
        new Request(new URL("/v1/snapshot", this.#baseUrl), {
          cache: "no-store",
          headers: requestHeaders(context),
          signal: AbortSignal.timeout(2_000),
        }),
      );
      if (!response.ok) {
        throw dependencyUnavailable("Personal data API", context.requestId);
      }
      return SnapshotSchema.parse(await response.json());
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw dependencyUnavailable("Personal data API", context.requestId, error);
    }
  }
}
