import "server-only";

import {
  AgentSummarySchema,
  ConversationSchema,
  HermesCapabilitiesSchema,
  MessageSchema,
  UploadedMediaSchema,
  type AgentSummary,
  type Conversation,
  type CreateConversationBody,
  type HermesCapabilities,
  type Message,
  type SendMessageBody,
  type UploadedMedia,
} from "@personal-intelligence-hub/contracts";
import { z } from "zod";

import type { RequestContext } from "../context";
import type { HermesGateway } from "../ports/hermes-gateway";
import { GatewayError, dependencyUnavailable } from "../problems";

type Options = Readonly<{
  baseUrl: string;
  serviceToken: string;
  fetcher?: typeof fetch;
}>;

type JsonMethod = "GET" | "POST";

export class HttpHermesGateway implements HermesGateway {
  readonly #baseUrl: string;
  readonly #serviceToken: string;
  readonly #fetcher: typeof fetch;

  constructor({ baseUrl, serviceToken, fetcher = fetch }: Options) {
    this.#baseUrl = baseUrl;
    this.#serviceToken = serviceToken;
    this.#fetcher = fetcher;
  }

  #headers(context: RequestContext): Headers {
    return new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.#serviceToken}`,
      "x-delegated-authorization": context.authorization,
      "x-request-id": context.requestId,
    });
  }

  async #json<T>(
    context: RequestContext,
    path: string,
    schema: z.ZodType<T>,
    method: JsonMethod = "GET",
    body?: unknown,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<T> {
    try {
      const headers = this.#headers(context);
      for (const [name, value] of Object.entries(extraHeaders ?? {})) {
        headers.set(name, value);
      }
      if (body !== undefined) headers.set("content-type", "application/json");
      const requestInit: RequestInit = {
        method,
        cache: "no-store",
        headers,
        signal: AbortSignal.timeout(2_000),
      };
      if (body !== undefined) requestInit.body = JSON.stringify(body);
      const response = await this.#fetcher(
        new Request(new URL(path, this.#baseUrl), requestInit),
      );
      if (!response.ok) throw dependencyUnavailable("Hermes", context.requestId);
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw dependencyUnavailable("Hermes", context.requestId, error);
    }
  }

  capabilities(context: RequestContext): Promise<HermesCapabilities> {
    return this.#json(context, "/v1/capabilities", HermesCapabilitiesSchema);
  }

  agents(context: RequestContext): Promise<readonly AgentSummary[]> {
    return this.#json(context, "/v1/agents", z.array(AgentSummarySchema));
  }

  async upload(
    context: RequestContext,
    file: File,
    kind: "attachment" | "voice",
  ): Promise<UploadedMedia> {
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("media", file);
      const response = await this.#fetcher(
        new Request(new URL("/v1/uploads", this.#baseUrl), {
          method: "POST",
          cache: "no-store",
          headers: this.#headers(context),
          body: form,
          signal: AbortSignal.timeout(2_000),
        }),
      );
      if (!response.ok) throw dependencyUnavailable("Hermes", context.requestId);
      return UploadedMediaSchema.parse(await response.json());
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw dependencyUnavailable("Hermes", context.requestId, error);
    }
  }

  createConversation(
    context: RequestContext,
    body: CreateConversationBody,
  ): Promise<Conversation> {
    return this.#json(
      context,
      "/v1/conversations",
      ConversationSchema,
      "POST",
      body,
    );
  }

  sendMessage(
    context: RequestContext,
    conversationId: string,
    idempotencyKey: string,
    body: SendMessageBody,
  ): Promise<Message> {
    return this.#json(
      context,
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      MessageSchema,
      "POST",
      body,
      { "idempotency-key": idempotencyKey },
    );
  }

  async events(
    context: RequestContext,
    conversationId: string,
    lastEventId?: string,
  ): Promise<Response> {
    try {
      const headers = this.#headers(context);
      headers.set("accept", "text/event-stream");
      if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
      const response = await this.#fetcher(
        new Request(
          new URL(
            `/v1/conversations/${encodeURIComponent(conversationId)}/events`,
            this.#baseUrl,
          ),
          { cache: "no-store", headers },
        ),
      );
      if (!response.ok) throw dependencyUnavailable("Hermes", context.requestId);
      return response;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw dependencyUnavailable("Hermes", context.requestId, error);
    }
  }
}
