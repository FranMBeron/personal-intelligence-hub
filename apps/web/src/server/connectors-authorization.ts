import "server-only";

import { webcrypto } from "node:crypto";
import { SignJWT } from "jose";
import {
  ConnectorScopeSchema,
  UuidSchema,
  type ConnectorScope,
} from "@personal-intelligence-hub/contracts";

import type { ConnectorsConfig } from "../config/server";
import type { VerifiedPrincipal } from "./context";

const delegatedIssuer = "personal-intelligence-hub-web";
const connectorsAudience = "personal-intelligence-hub-connectors";

export const signConnectorsAuthorization = async (
  principal: VerifiedPrincipal,
  requestId: string,
  scopes: readonly ConnectorScope[],
  configuration: Pick<ConnectorsConfig, "delegatedJwtKey">,
  clock: () => Date = () => new Date(),
): Promise<string> => {
  if (
    principal.actorType !== "human" ||
    !UuidSchema.safeParse(principal.actorId).success ||
    principal.subject.trim() === "" ||
    !UuidSchema.safeParse(requestId).success ||
    scopes.length === 0 ||
    scopes.some((scope) => !ConnectorScopeSchema.safeParse(scope).success) ||
    configuration.delegatedJwtKey.byteLength !== 32
  ) {
    throw new Error("Cannot delegate an invalid connector principal or request.");
  }

  const now = Math.floor(clock().getTime() / 1000);
  const signingKey = await webcrypto.subtle.importKey(
    "raw",
    configuration.delegatedJwtKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const token = await new SignJWT({
    actor_id: principal.actorId,
    actor_type: principal.actorType,
    scope: [...new Set(scopes)],
    request_id: requestId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(principal.subject)
    .setIssuer(delegatedIssuer)
    .setAudience(connectorsAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .sign(signingKey);

  return `Bearer ${token}`;
};
