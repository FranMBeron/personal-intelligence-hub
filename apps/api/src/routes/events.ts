import { DecimalSequenceSchema, type OutboxEvent } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { CursorExpiredError, InvalidCursorError } from "../application/errors.js";
import type { EventBus } from "../events/event-bus.js";
import type { OutboxStore } from "../events/outbox-dispatcher.js";

export type SynchronizationDependencies = Readonly<{
  eventBus: EventBus;
  outboxStore: OutboxStore;
  heartbeatMilliseconds?: number;
}>;

const singleHeader = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

const writeEvent = (reply: FastifyReply, event: OutboxEvent): void => {
  reply.raw.write(
    `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
  );
};

const parseLastEventId = (request: FastifyRequest): string | undefined => {
  const value = singleHeader(request.headers["last-event-id"]);
  if (value === undefined) return undefined;
  const parsed = DecimalSequenceSchema.safeParse(value);
  if (!parsed.success) throw new InvalidCursorError(parsed.error);
  return parsed.data;
};

const eventRouteSchema = {
  security: [{ bearerAuth: [] }],
  headers: {
    type: "object",
    additionalProperties: true,
    properties: {
      "last-event-id": {
        type: "string",
        description: "Decimal outbox sequence; validated as an event cursor.",
      },
    },
  },
  response: {
    200: {
      description: "Server-Sent Events stream of committed outbox events.",
      content: {
        "text/event-stream": { schema: { type: "string" } },
      },
    },
    400: {
      description: "The event cursor is invalid.",
      content: {
        "application/problem+json": { schema: { $ref: "ApiProblem#" } },
      },
    },
    401: {
      description: "Authentication required.",
      content: {
        "application/problem+json": { schema: { $ref: "ApiProblem#" } },
      },
    },
    403: {
      description: "The principal is not authorized.",
      content: {
        "application/problem+json": { schema: { $ref: "ApiProblem#" } },
      },
    },
    409: {
      description: "The event cursor predates retained history.",
      content: {
        "application/problem+json": { schema: { $ref: "ApiProblem#" } },
      },
    },
  },
} as const;

export const registerEventRoute = (
  app: FastifyInstance,
  dependencies: SynchronizationDependencies,
): void => {
  app.get(
    "/v1/events",
    {
      config: { pihSecurity: { scopes: ["second-brain:read"] } },
      schema: eventRouteSchema,
    },
    async (request, reply) => {
      const suppliedSequence = parseLastEventId(request);
      const retention = await dependencies.outboxStore.retentionState();
      if (
        suppliedSequence !== undefined &&
        retention.lastExpiredSequence !== null &&
        BigInt(suppliedSequence) < BigInt(retention.lastExpiredSequence)
      ) {
        void reply.header("link", '</v1/snapshot>; rel="recovery"');
        throw new CursorExpiredError();
      }

      const startSequence = suppliedSequence ?? retention.latestSequence;
      const seen = new Set<string>();
      const pending = new Map<string, OutboxEvent>();
      let replaying = true;
      let closed = false;
      let heartbeat: NodeJS.Timeout | undefined;

      const send = (event: OutboxEvent): void => {
        if (closed || seen.has(event.eventId)) return;
        seen.add(event.eventId);
        writeEvent(reply, event);
      };
      const unsubscribe = dependencies.eventBus.subscribe((event) => {
        if (replaying) {
          pending.set(event.eventId, event);
          return;
        }
        send(event);
      });

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.once("close", cleanup);
      reply.raw.once("close", cleanup);

      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
        "x-request-id": request.pihRequestId,
      });
      reply.raw.write(": connected\n\n");
      heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(": heartbeat\n\n");
      }, dependencies.heartbeatMilliseconds ?? 15_000);
      heartbeat.unref();

      try {
        const replay = await dependencies.outboxStore.readAfter(startSequence);
        for (const event of replay) send(event);
        replaying = false;
        for (const event of [...pending.values()].sort((left, right) =>
          BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1,
        )) {
          send(event);
        }
        pending.clear();
      } catch (error) {
        cleanup();
        reply.raw.destroy(error instanceof Error ? error : undefined);
      }
    },
  );
};
