import {
  DelegationListSchema,
  DelegationSchema,
  type Delegation,
  type DelegationList,
  type DelegationListQuery,
} from "@personal-intelligence-hub/contracts";

export class DelegationClientError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("The delegation request could not be completed.");
    this.name = "DelegationClientError";
    this.status = status;
  }
}

/** Read-only browser client for the BFF delegation ledger routes. */
export type DelegationReader = Readonly<{
  list(query: Partial<DelegationListQuery>, signal?: AbortSignal): Promise<DelegationList>;
  get(id: string, signal?: AbortSignal): Promise<Delegation>;
}>;

const QUERY_KEYS = ["sourceAgentId", "targetAgentId", "sourceConversationId", "state", "cursor", "limit"] as const;

export class DelegationClient implements DelegationReader {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async #request<T>(path: string, schema: { parse(value: unknown): T }, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(path, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new DelegationClientError(response.status);
    return schema.parse(await response.json());
  }

  list(query: Partial<DelegationListQuery>, signal?: AbortSignal): Promise<DelegationList> {
    const parameters = new URLSearchParams();
    for (const key of QUERY_KEYS) {
      const value = query[key];
      if (value !== undefined) parameters.set(key, String(value));
    }
    const search = parameters.toString();
    return this.#request(`/api/ui/v1/delegations${search === "" ? "" : `?${search}`}`, DelegationListSchema, signal);
  }

  get(id: string, signal?: AbortSignal): Promise<Delegation> {
    return this.#request(`/api/ui/v1/delegations/${encodeURIComponent(id)}`, DelegationSchema, signal);
  }
}
