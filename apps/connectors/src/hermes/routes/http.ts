import type { ConnectorScope, DelegatedPrincipal } from "@personal-intelligence-hub/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { requireScope, requireService } from "../../foundation/auth.js";
import { routeFail } from "./problems.js";

/** Every Hermes BFF route is reachable only by the verified web service. */
const WEB_ONLY = ["pih-web"] as const;
/** Fastify's router already refuses longer parameters; repeat the bound locally. */
const MAX_PATH_REF_LENGTH = 100;

/**
 * Authorize from the verified principal only: the scope must be granted and the
 * service, derived by Foundation from the service credential and issuer, must be
 * the web BFF. Runs before any parsing or service work.
 */
export const authorize = (request: FastifyRequest, scope: ConnectorScope): DelegatedPrincipal => {
  const principal = requireScope(request, scope);
  requireService(request, WEB_ONLY);
  return principal;
};

const PathRefSchema = z.string().min(1).max(MAX_PATH_REF_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/** Strictly parse named path parameters; malformed references are indistinguishable from absent ones. */
export const pathRefs = <K extends string>(request: FastifyRequest, ...names: readonly K[]): Readonly<Record<K, string>> => {
  const params = request.params as Record<string, unknown>;
  const result = {} as Record<K, string>;
  for (const name of names) {
    const parsed = PathRefSchema.safeParse(params[name]);
    if (!parsed.success) return routeFail("not_found");
    result[name] = parsed.data;
  }
  return result;
};

/** A copy of the query object (Fastify's has a null prototype); unknown fields are left for strict schemas. */
export const queryOf = (request: FastifyRequest): Record<string, unknown> => ({ ...(request.query as object) });

export const parseQuery = <T>(request: FastifyRequest, schema: z.ZodType<T>): T => {
  const parsed = schema.safeParse(queryOf(request));
  return parsed.success ? parsed.data : routeFail("validation_failed");
};

export const noQuery = (request: FastifyRequest): void => {
  if (Object.keys(request.query as object).length > 0) routeFail("validation_failed");
};

/** Accept an absent body or an empty JSON object on operations that take no input. */
export const noBody = (request: FastifyRequest): void => {
  const body = request.body;
  if (body === undefined || body === null) return;
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) return;
  routeFail("validation_failed");
};

/** Exactly one raw header value; Node folds repeated headers, so count raw entries. */
export const singleHeader = (request: FastifyRequest, name: string): string | undefined => {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name) values.push(raw[index + 1] ?? "");
  }
  if (values.length === 0) return undefined;
  if (values.length !== 1) return routeFail("validation_failed");
  return values[0];
};
