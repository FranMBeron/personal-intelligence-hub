import { ApiProblemSchema } from "@personal-intelligence-hub/contracts";

/** A failed same-origin BFF request. Only the HTTP status and the validated safe problem code are kept. */
export class BffRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null) {
    super("The request could not be completed.");
    this.name = "BffRequestError";
    this.status = status;
    this.code = code;
  }
}

export type Fetcher = typeof fetch;

const safeProblemCode = async (response: Response): Promise<string | null> => {
  try {
    const parsed = ApiProblemSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.code : null;
  } catch {
    return null;
  }
};

/** Typed JSON request to the BFF; the response body is always validated against the shared contract schema. */
export const bffJson = async <T>(
  fetcher: Fetcher,
  path: string,
  schema: { parse(value: unknown): T },
  options: Readonly<{ method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal | undefined; headers?: Record<string, string> }> = {},
): Promise<T> => {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetcher(path, {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    headers,
    ...(options.method === undefined ? {} : { method: options.method }),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) throw new BffRequestError(response.status, await safeProblemCode(response));
  return schema.parse(await response.json());
};
