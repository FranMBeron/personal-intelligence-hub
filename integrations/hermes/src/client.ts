import {
  ApiProblemSchema,
  type ApiProblem,
} from "@personal-intelligence-hub/contracts";
import type { z } from "zod";

type FetchImplementation = typeof fetch;

export type MutationRequest<T extends z.ZodType> = Readonly<{
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/v1/${string}`;
  responseSchema: T;
  body?: unknown;
  ifMatch?: string;
}>;

export class HermesApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(`${problem.status} ${problem.code}`);
    this.name = "HermesApiError";
  }
}

export class HermesSecondBrainClient {
  readonly #baseUrl: URL;
  readonly #credential: string;
  readonly #fetch: FetchImplementation;
  readonly #idempotencyKeyFactory: () => string;
  readonly #requestIdFactory: () => string;

  constructor(options: Readonly<{
    baseUrl: string;
    credential: string;
    fetch?: FetchImplementation;
    idempotencyKeyFactory: () => string;
    requestIdFactory: () => string;
  }>) {
    const baseUrl = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.search !== "" ||
      baseUrl.hash !== ""
    ) {
      throw new Error("Hermes API base URL must be an uncredentialed HTTP(S) URL.");
    }
    if (options.credential.trim() === "") {
      throw new Error("Hermes API credential is required.");
    }
    this.#baseUrl = baseUrl;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? fetch;
    this.#idempotencyKeyFactory = options.idempotencyKeyFactory;
    this.#requestIdFactory = options.requestIdFactory;
  }

  #url(path: `/v1/${string}`): URL {
    return new URL(path, this.#baseUrl);
  }

  async #decode<T extends z.ZodType>(
    response: Response,
    responseSchema: T,
    requestId: string,
  ): Promise<z.infer<T>> {
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const problem = ApiProblemSchema.safeParse(value);
      if (problem.success) throw new HermesApiError(problem.data);
      throw new HermesApiError({
        type: "https://pih.example/problems/dependency-unavailable",
        title: "Dependency unavailable",
        status: 503,
        detail: "The Second Brain API returned an unreadable response.",
        instance: "/v1/hermes-integration",
        code: "dependency_unavailable",
        requestId,
      });
    }
    return responseSchema.parse(value);
  }

  async read<T extends z.ZodType>(
    path: `/v1/${string}`,
    responseSchema: T,
  ): Promise<Readonly<{ body: z.infer<T>; etag: string | null }>> {
    const requestId = this.#requestIdFactory();
    const response = await this.#fetch(
      new Request(this.#url(path), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#credential}`,
          "x-request-id": requestId,
        },
      }),
    );
    return {
      body: await this.#decode(response, responseSchema, requestId),
      etag: response.headers.get("etag"),
    };
  }

  async mutate<T extends z.ZodType>(
    request: MutationRequest<T>,
  ): Promise<z.infer<T>> {
    const idempotencyKey = this.#idempotencyKeyFactory();
    const requestId = this.#requestIdFactory();
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        response = await this.#fetch(
          new Request(this.#url(request.path), {
            method: request.method,
            headers: {
              accept: "application/json",
              authorization: `Bearer ${this.#credential}`,
              "idempotency-key": idempotencyKey,
              "x-origin-channel": "hermes-web",
              "x-request-id": requestId,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              ...(request.ifMatch === undefined
                ? {}
                : { "if-match": request.ifMatch }),
            },
            ...(body === undefined ? {} : { body }),
          }),
        );
        break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    if (response === undefined) {
      throw new Error("Hermes transport did not produce a response.");
    }
    return this.#decode(response, request.responseSchema, requestId);
  }

  async withEtag<T>(
    path: `/v1/${string}`,
    responseSchema: z.ZodType,
    operation: (etag: string) => Promise<T>,
  ): Promise<T> {
    const resource = await this.read(path, responseSchema);
    if (resource.etag === null) {
      throw new Error("The Second Brain API response omitted its resource ETag.");
    }
    return operation(resource.etag);
  }
}
