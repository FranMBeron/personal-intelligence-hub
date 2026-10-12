import { DecimalSequenceSchema, type OutboxEvent } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { CursorExpiredError, InvalidCursorError } from "../application/errors.js";
import type { EventBus } from "../events/event-bus.js";
import type { OutboxStore } from "../events/outbox-dispatcher.js";

export type SynchronizationDependencies = Readonly<{
  eventBus: EventBus;
  outboxStore: OutboxStore;
  heartbeatMilliseconds?: number;
  pollMilliseconds?: number;
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

const requestIdHeader = {
  "X-Request-Id": { type: "string", format: "uuid" },
} as const;

const problemResponse = (description: string, includeRecoveryLink = false) => ({
  description,
  headers: {
    ...requestIdHeader,
    ...(includeRecoveryLink ? { Link: { type: "string" } } : {}),
  },
  content: {
    "application/problem+json": { schema: { $ref: "ApiProblem#" } },
  },
});

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
      headers: requestIdHeader,
      content: {
        "text/event-stream": { schema: { type: "string" } },
      },
    },
    400: problemResponse("The event cursor is invalid."),
    401: problemResponse("Authentication required."),
    403: problemResponse("The principal is not authorized."),
    409: problemResponse("The event cursor predates retained history.", true),
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
      let lastSequence = startSequence;
      let closed = false;
      const timers: {
        heartbeat?: NodeJS.Timeout;
        poller?: NodeJS.Timeout;
      } = {};
      let unsubscribe = (): void => undefined;
      let draining: Promise<void> | undefined;

      const send = (event: OutboxEvent): void => {
        if (closed || seen.has(event.eventId)) return;
        seen.add(event.eventId);
        writeEvent(reply, event);
        if (BigInt(event.sequence) > BigInt(lastSequence)) {
          lastSequence = event.sequence;
        }
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (timers.heartbeat !== undefined) clearInterval(timers.heartbeat);
        if (timers.poller !== undefined) clearInterval(timers.poller);
        unsubscribe();
      };
      const fail = (error: unknown): void => {
        cleanup();
        reply.raw.destroy(error instanceof Error ? error : undefined);
      };
      const drain = (): Promise<void> => {
        if (closed) return Promise.resolve();
        if (draining !== undefined) return draining;
        draining = (async () => {
          const events = await dependencies.outboxStore.readAfter(lastSequence);
          for (const event of [...events].sort((left, right) =>
            BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1,
          )) {
            send(event);
          }
        })().finally(() => {
          draining = undefined;
        });
        return draining;
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
      timers.heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(": heartbeat\n\n");
      }, dependencies.heartbeatMilliseconds ?? 15_000);
      timers.heartbeat.unref();
      unsubscribe = dependencies.eventBus.subscribe(() => {
        void drain().catch(fail);
      });
      timers.poller = setInterval(() => {
        void drain().catch(fail);
      }, dependencies.pollMilliseconds ?? 1_000);
      timers.poller.unref();

      try {
        await drain();
      } catch (error) {
        fail(error);
      }
    },
  );
};
