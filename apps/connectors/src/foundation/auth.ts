import {
  DelegatedAuthorizationClaimsSchema,
  type ConnectorScope,
  type ConnectorServiceId,
  type DelegatedPrincipal,
} from "@personal-intelligence-hub/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { decodeJwt, jwtVerify } from "jose";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  CONNECTORS_AUDIENCE,
  type ConnectorsConfig,
  type ServiceCredentialPolicy,
} from "../config/private.js";
import {
  ConnectorProblem,
  installConnectorProblemHandler,
} from "./problems.js";

export type ConnectorRequest = FastifyRequest & {
  authenticatedService?: Readonly<{ serviceId: string }>;
  delegatedPrincipal?: DelegatedPrincipal;
};

export type ConnectorAuthenticationOptions = Readonly<{
  preAuthenticationLimit?: Readonly<{
    processWideMax?: number;
    credentialMax?: number;
    timeWindowMs?: number;
    credentialBucketCapacity?: number;
  }>;
  requestIdFactory?: (request: FastifyRequest) => string;
  now?: () => number;
}>;

declare module "fastify" {
  interface FastifyRequest {
    authenticatedService?: Readonly<{ serviceId: string }>;
    delegatedPrincipal?: DelegatedPrincipal;
  }
}

type FixedWindow = {
  count: number;
  resetAt: number;
};

const DEFAULT_PROCESS_WIDE_MAX = 10_000;
const DEFAULT_CREDENTIAL_MAX = 300;
const DEFAULT_TIME_WINDOW_MS = 60_000;
const MAX_CREDENTIAL_BUCKETS = 10_000;
const MAX_DELEGATED_TOKEN_LIFETIME_SECONDS = 30;
const DELEGATED_CLOCK_TOLERANCE_SECONDS = 5;

const authenticationRequired = (): ConnectorProblem =>
  new ConnectorProblem("authentication_required", 401);

const forbidden = (): ConnectorProblem =>
  new ConnectorProblem("forbidden", 403);

const rateLimitExceeded = (): ConnectorProblem =>
  new ConnectorProblem("rate_limit_exceeded", 429);

const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const positiveOption = (
  value: number | undefined,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!isPositiveInteger(resolved)) {
    throw new Error(name + " must be a positive integer");
  }
  return resolved;
};

const consumeWindow = (
  bucket: FixedWindow,
  maximum: number,
  timeWindowMs: number,
  now: number,
): boolean => {
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + timeWindowMs;
  }
  if (bucket.count >= maximum) return false;
  bucket.count += 1;
  return true;
};

class CredentialBucketLru {
  readonly #buckets = new Map<string, FixedWindow>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = Math.min(capacity, MAX_CREDENTIAL_BUCKETS);
  }

  consume(
    key: string,
    maximum: number,
    timeWindowMs: number,
    now: number,
  ): boolean {
    let bucket = this.#buckets.get(key);
    if (bucket !== undefined && now >= bucket.resetAt) {
      this.#buckets.delete(key);
      bucket = undefined;
    }
    if (bucket === undefined) {
      while (this.#buckets.size >= this.#capacity) {
        const oldest = this.#buckets.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#buckets.delete(oldest);
      }
      bucket = { count: 0, resetAt: now + timeWindowMs };
    } else {
      this.#buckets.delete(key);
    }
    this.#buckets.set(key, bucket);
    return consumeWindow(bucket, maximum, timeWindowMs, now);
  }
}

const requestPath = (request: FastifyRequest): string =>
  request.url.split("?", 1)[0] ?? request.url;

const rawHeaderValues = (
  request: FastifyRequest,
  headerName: string,
): readonly string[] => {
  const values: string[] = [];
  const headers = request.raw.rawHeaders;
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === headerName) {
      values.push(headers[index + 1] ?? "");
    }
  }
  return values;
};

const exactSingleHeader = (
  request: FastifyRequest,
  headerName: "authorization" | "x-pih-service-token",
): string => {
  const rawValues = rawHeaderValues(request, headerName);
  const normalized = request.headers[headerName];
  if (
    rawValues.length !== 1 ||
    typeof normalized !== "string" ||
    normalized !== rawValues[0] ||
    normalized.trim().length === 0 ||
    normalized.includes(",")
  ) {
    throw authenticationRequired();
  }
  return normalized;
};

const constantTimeServiceMatch = (
  presentedToken: string,
  credentials: readonly ServiceCredentialPolicy[],
): ConnectorServiceId | undefined => {
  const presented = Buffer.from(presentedToken, "utf8");
  let matched: ConnectorServiceId | undefined;
  try {
    for (const credential of credentials) {
      const configured = Buffer.from(credential.serviceToken, "utf8");
      const comparisonLength = Math.max(presented.length, configured.length, 1);
      const paddedPresented = Buffer.alloc(comparisonLength);
      const paddedConfigured = Buffer.alloc(comparisonLength);
      try {
        presented.copy(paddedPresented);
        configured.copy(paddedConfigured);
        if (
          timingSafeEqual(paddedPresented, paddedConfigured) &&
          presented.length === configured.length
        ) {
          matched = credential.serviceId;
        }
      } finally {
        configured.fill(0);
        paddedPresented.fill(0);
        paddedConfigured.fill(0);
      }
    }
  } finally {
    presented.fill(0);
  }
  return matched;
};

const limiterCredentialMaterial = (request: FastifyRequest): string | undefined => {
  const rawValues = rawHeaderValues(request, "x-pih-service-token");
  if (rawValues.length === 0) return undefined;
  return rawValues.length === 1 ? rawValues[0] : rawValues.join("\u0000");
};

const credentialBucketKey = (
  request: FastifyRequest,
  credentials: readonly ServiceCredentialPolicy[],
  hmacKey: Uint8Array,
): string => {
  const material = limiterCredentialMaterial(request);
  if (material === undefined) return "missing";
  const rawValues = rawHeaderValues(request, "x-pih-service-token");
  const serviceId =
    rawValues.length === 1 && !material.includes(",")
      ? constantTimeServiceMatch(material, credentials)
      : undefined;
  if (serviceId !== undefined) return "service:" + serviceId;
  return (
    "invalid:" + createHmac("sha256", hmacKey).update(material).digest("hex")
  );
};

const bearerToken = (authorization: string): string => {
  const match = /^Bearer ([^\s,]+)$/u.exec(authorization);
  if (match?.[1] === undefined) throw authenticationRequired();
  return match[1];
};

const credentialByIssuer = (
  token: string,
  credentials: readonly ServiceCredentialPolicy[],
): ServiceCredentialPolicy => {
  let issuer: unknown;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    throw authenticationRequired();
  }
  if (typeof issuer !== "string") throw authenticationRequired();
  const matches = credentials.filter(
    (credential) => credential.delegatedIssuer === issuer,
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw authenticationRequired();
  }
  return matches[0];
};

const verifyDelegatedPrincipal = async (
  token: string,
  credential: ServiceCredentialPolicy,
  now: number,
): Promise<Omit<DelegatedPrincipal, "serviceId">> => {
  const key = new Uint8Array(credential.delegatedKey);
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: credential.delegatedIssuer,
      audience: CONNECTORS_AUDIENCE,
      currentDate: new Date(now),
      clockTolerance: DELEGATED_CLOCK_TOLERANCE_SECONDS,
    });
    const nowSeconds = now / 1_000;
    if (
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      typeof payload.exp !== "number" ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > MAX_DELEGATED_TOKEN_LIFETIME_SECONDS ||
      payload.iat > nowSeconds + DELEGATED_CLOCK_TOLERANCE_SECONDS ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0
    ) {
      throw authenticationRequired();
    }
    const claims = DelegatedAuthorizationClaimsSchema.safeParse({
      actor_id: payload.actor_id,
      actor_type: payload.actor_type,
      scope: payload.scope,
      request_id: payload.request_id,
    });
    if (!claims.success) throw authenticationRequired();
    return {
      subject: payload.sub,
      actorId: claims.data.actor_id,
      actorType: claims.data.actor_type,
      scopes: claims.data.scope,
      requestId: claims.data.request_id,
    };
  } catch (error) {
    if (error instanceof ConnectorProblem) throw error;
    throw authenticationRequired();
  } finally {
    key.fill(0);
  }
};

const enforcePolicy = (
  principal: Omit<DelegatedPrincipal, "serviceId">,
  credential: ServiceCredentialPolicy,
): void => {
  if (
    !credential.actorTypes.includes(principal.actorType) ||
    principal.scopes.some((scope) => !credential.maxScopes.includes(scope))
  ) {
    throw forbidden();
  }
  if (
    principal.actorType !== "human" &&
    principal.scopes.some(
      (scope) => scope === "calendar:confirm" || scope === "calendar:configure",
    )
  ) {
    throw forbidden();
  }
};

export const requireScope = (
  request: FastifyRequest,
  scope: ConnectorScope,
): DelegatedPrincipal => {
  const principal = request.delegatedPrincipal;
  if (principal === undefined) throw authenticationRequired();
  if (!principal.scopes.includes(scope)) throw forbidden();
  return principal;
};

export const requireService = (
  request: FastifyRequest,
  allowed: readonly ConnectorServiceId[],
): ConnectorServiceId => {
  const serviceId = request.delegatedPrincipal?.serviceId;
  if (serviceId === undefined) throw authenticationRequired();
  if (!allowed.includes(serviceId)) throw forbidden();
  return serviceId;
};

export const installConnectorAuthentication = (
  app: FastifyInstance,
  config: ConnectorsConfig,
  options: ConnectorAuthenticationOptions = {},
): void => {
  app.setChildLoggerFactory((logger, bindings, childOptions) =>
    logger.child(bindings, {
      ...childOptions,
      serializers: {
        ...childOptions.serializers,
        req: (request) => ({ method: request.method }),
      },
    }),
  );

  const configuredLimit = options.preAuthenticationLimit;
  const processWideMax = positiveOption(
    configuredLimit?.processWideMax,
    DEFAULT_PROCESS_WIDE_MAX,
    "processWideMax",
  );
  const credentialMax = positiveOption(
    configuredLimit?.credentialMax,
    DEFAULT_CREDENTIAL_MAX,
    "credentialMax",
  );
  const timeWindowMs = positiveOption(
    configuredLimit?.timeWindowMs,
    DEFAULT_TIME_WINDOW_MS,
    "timeWindowMs",
  );
  const credentialBucketCapacity = positiveOption(
    configuredLimit?.credentialBucketCapacity,
    MAX_CREDENTIAL_BUCKETS,
    "credentialBucketCapacity",
  );
  const processWideBucket: FixedWindow = { count: 0, resetAt: 0 };
  const credentialBuckets = new CredentialBucketLru(credentialBucketCapacity);
  const hmacKey = randomBytes(32);

  app.decorateRequest("authenticatedService");
  app.decorateRequest("delegatedPrincipal");
  if (options.requestIdFactory === undefined) {
    installConnectorProblemHandler(app);
  } else {
    installConnectorProblemHandler(app, options.requestIdFactory);
  }

  app.addHook("onClose", async () => {
    hmacKey.fill(0);
  });

  app.addHook("onRequest", async (request) => {
    if (requestPath(request) === "/health/live") return;
    const now = Date.now();
    const processAllowed = consumeWindow(
      processWideBucket,
      processWideMax,
      timeWindowMs,
      now,
    );
    const bucketKey = credentialBucketKey(
      request,
      config.serviceCredentials,
      hmacKey,
    );
    const credentialAllowed = credentialBuckets.consume(
      bucketKey,
      credentialMax,
      timeWindowMs,
      now,
    );
    if (!processAllowed || !credentialAllowed) throw rateLimitExceeded();
  });

  app.addHook("onRequest", async (request) => {
    if (requestPath(request) === "/health/live") return;
    let serviceToken = "";
    let delegatedToken = "";
    try {
      serviceToken = exactSingleHeader(request, "x-pih-service-token");
      const tokenServiceId = constantTimeServiceMatch(
        serviceToken,
        config.serviceCredentials,
      );
      if (tokenServiceId === undefined) throw authenticationRequired();

      delegatedToken = bearerToken(
        exactSingleHeader(request, "authorization"),
      );
      const issuerCredential = credentialByIssuer(
        delegatedToken,
        config.serviceCredentials,
      );
      const principalWithoutService = await verifyDelegatedPrincipal(
        delegatedToken,
        issuerCredential,
        options.now?.() ?? Date.now(),
      );
      if (tokenServiceId !== issuerCredential.serviceId) {
        throw authenticationRequired();
      }
      enforcePolicy(principalWithoutService, issuerCredential);

      const authenticatedService = Object.freeze({
        serviceId: tokenServiceId,
      });
      const principal: DelegatedPrincipal = {
        ...principalWithoutService,
        serviceId: tokenServiceId,
        scopes: [...principalWithoutService.scopes],
      };
      Object.freeze(principal.scopes);
      Object.freeze(principal);
      request.authenticatedService = authenticatedService;
      request.delegatedPrincipal = principal;
    } catch (error) {
      if (error instanceof ConnectorProblem) throw error;
      throw authenticationRequired();
    } finally {
      serviceToken = "";
      delegatedToken = "";
    }
  });
};
