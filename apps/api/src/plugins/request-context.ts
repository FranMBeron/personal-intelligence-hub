import { RequestIdSchema } from "@personal-intelligence-hub/contracts";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { ValidationError } from "../application/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    pihRequestId: string;
  }
}

export type RequestIdFactory = () => string;

const singleHeader = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

export const installRequestContext = (
  app: FastifyInstance,
  requestIdFactory: RequestIdFactory = randomUUID,
): void => {
  app.decorateRequest("pihRequestId");

  app.addHook("onRequest", async (request) => {
    const generated = RequestIdSchema.safeParse(requestIdFactory());
    request.pihRequestId = generated.success ? generated.data : randomUUID();

    const supplied = singleHeader(request.headers["x-request-id"]);
    if (supplied === undefined) {
      if (request.headers["x-request-id"] !== undefined) {
        throw new ValidationError([
          {
            path: "headers.x-request-id",
            message: "X-Request-Id must be a UUID.",
            code: "invalid_format",
          },
        ]);
      }
      return;
    }

    const parsed = RequestIdSchema.safeParse(supplied);
    if (!parsed.success) {
      throw new ValidationError([
        {
          path: "headers.x-request-id",
          message: "X-Request-Id must be a UUID.",
          code: "invalid_format",
        },
      ]);
    }
    request.pihRequestId = parsed.data;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!reply.hasHeader("x-request-id")) {
      void reply.header("x-request-id", request.pihRequestId);
    }
    return payload;
  });
};
