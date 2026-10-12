import { createHmac, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const CONNECTORS_AUDIENCE = "personal-intelligence-hub-connectors";
const DEPLOYER_ISSUER = "pih-deployer";
const READINESS_PATH = "/health/ready";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 16_384;

const required = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Connector readiness check failed");
  }
  return value;
};

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

const signingKey = (encoded) => {
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("Connector readiness check failed");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encoded) {
    decoded.fill(0);
    throw new Error("Connector readiness check failed");
  }
  return decoded;
};

const createAuthorization = (environment) => {
  const issuer = required(environment, "CONNECTORS_DEPLOYER_ISSUER");
  const actorId = required(environment, "CONNECTORS_DEPLOYER_ACTOR_ID");
  const encodedKey = required(environment, "CONNECTORS_DEPLOYER_SIGNING_KEY");
  if (issuer !== DEPLOYER_ISSUER || actorId.trim() !== actorId) {
    throw new Error("Connector readiness check failed");
  }
  const key = signingKey(encodedKey);
  try {
    const issuedAt = Math.floor(Date.now() / 1_000);
    const header = base64url({ alg: "HS256", typ: "JWT" });
    const claims = base64url({
      iss: DEPLOYER_ISSUER,
      sub: actorId,
      aud: CONNECTORS_AUDIENCE,
      actor_id: actorId,
      actor_type: "service",
      scope: ["health:read"],
      request_id: randomUUID(),
      iat: issuedAt,
      exp: issuedAt + 30,
    });
    const signature = createHmac("sha256", key)
      .update(`${header}.${claims}`)
      .digest("base64url");
    return `Bearer ${header}.${claims}.${signature}`;
  } finally {
    key.fill(0);
  }
};

const isReadyBody = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "database,migrations,modules,status") return false;
  if (
    (body.status !== "ready" && body.status !== "not_ready") ||
    typeof body.database !== "boolean" ||
    typeof body.migrations !== "boolean" ||
    typeof body.modules !== "boolean"
  ) return false;
  return body.status === "ready" &&
    body.database === true &&
    body.migrations === true &&
    body.modules === true;
};

const sendReadinessRequest = (socketPath, serviceToken, authorization, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error("Connector readiness check failed"));
    };
    const req = httpRequest({
      socketPath,
      method: "GET",
      path: READINESS_PATH,
      headers: {
        "x-pih-service-token": serviceToken,
        authorization,
      },
    }, (response) => {
      const contentType = response.headers["content-type"] ?? "";
      const chunks = [];
      let byteLength = 0;
      response.on("data", (chunk) => {
        byteLength += chunk.length;
        if (byteLength > MAX_RESPONSE_BYTES) {
          response.destroy();
          fail();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", fail);
      response.on("end", () => {
        if (
          settled ||
          response.statusCode !== 200 ||
          !/^application\/json(?:\s*;|$)/iu.test(contentType)
        ) {
          fail();
          return;
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          fail();
          return;
        }
        if (!isReadyBody(body)) {
          fail();
          return;
        }
        settled = true;
        clearTimeout(deadline);
        resolve();
      });
    });
    deadline = setTimeout(() => {
      req.destroy();
      fail();
    }, timeoutMs);
    req.on("error", fail);
    req.end();
  });

export const checkConnectorsReadiness = async (
  environment = process.env,
  options = {},
) => {
  try {
    const socketPath = required(environment, "CONNECTORS_SOCKET_PATH");
    const serviceToken = required(environment, "CONNECTORS_DEPLOYER_SERVICE_TOKEN");
    if (
      !isAbsolute(socketPath) ||
      Buffer.byteLength(serviceToken, "utf8") < 32
    ) throw new Error("Connector readiness check failed");
    const authorization = createAuthorization(environment);
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Connector readiness check failed");
    }
    await sendReadinessRequest(socketPath, serviceToken, authorization, timeoutMs);
  } catch {
    throw new Error("Connector readiness check failed");
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  checkConnectorsReadiness().catch(() => {
    process.stderr.write("Connector readiness check failed.\\n");
    process.exitCode = 1;
  });
}
