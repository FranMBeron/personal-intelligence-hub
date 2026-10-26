import {
  MessageHistorySchema,
  MessageSchema,
  type MessagePageQuery,
  type SendMessageBody,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";

import type { HermesRouteServices } from "../runtime.js";
import { authorize, noQuery, pathRefs, queryOf, singleHeader } from "./http.js";
import { routeFail } from "./problems.js";

/** Resolves when the response can take more bytes, or when the stream is being torn down. */
const drained = (response: ServerResponse, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  const done = () => {
    response.off("drain", done);
    response.off("close", done);
    signal.removeEventListener("abort", done);
    resolve();
  };
  response.once("drain", done);
  response.once("close", done);
  signal.addEventListener("abort", done, { once: true });
});

export const registerMessageRoutes = async (app: FastifyInstance, services: HermesRouteServices): Promise<void> => {
  app.get("/v1/conversations/:id/messages", async (request) => {
    const principal = authorize(request, "hermes:conversations:read");
    const { id } = pathRefs(request, "id");
    return MessageHistorySchema.parse(await services.conversations.messages(principal, id, queryOf(request) as MessagePageQuery));
  });

  app.post("/v1/conversations/:id/messages", async (request, reply) => {
    const principal = authorize(request, "hermes:conversations:write");
    const { id } = pathRefs(request, "id");
    noQuery(request);
    const idempotencyKey = singleHeader(request, "idempotency-key") ?? routeFail("idempotency_key_required");
    const message = MessageSchema.parse(await services.messages.send(principal, id, idempotencyKey, request.body as SendMessageBody));
    return reply.code(202).send(message);
  });

  app.get("/v1/conversations/:id/events", async (request, reply) => {
    const principal = authorize(request, "hermes:conversations:read");
    const { id } = pathRefs(request, "id");
    noQuery(request);
    const lastEventId = singleHeader(request, "last-event-id");
    const release = services.streams.acquire(principal.actorId);
    const connection = new AbortController();
    const signal = AbortSignal.any([connection.signal, services.streamShutdown]);
    let frames: AsyncIterable<string>;
    try {
      // Ownership and cursor are validated here, so 404/410 are answered before any SSE header.
      frames = await services.events.open({
        principal, conversationId: id, signal, ...(lastEventId === undefined ? {} : { lastEventId }),
      });
    } catch (error) {
      release();
      throw error;
    }

    reply.hijack();
    const response = reply.raw;
    const abort = () => connection.abort();
    request.raw.once("close", abort);
    response.once("close", abort);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-request-id": request.id,
    });
    void (async () => {
      try {
        for await (const frame of frames) {
          if (signal.aborted) break;
          if (!response.write(frame)) await drained(response, signal);
        }
      } catch {
        // The stream ends; the client reloads history and reconnects with its last event ID.
      } finally {
        release();
        request.raw.off("close", abort);
        response.off("close", abort);
        if (!response.writableEnded) response.end();
      }
    })();
  });
};
