import "server-only";

import { request as httpRequest } from "node:http";
import { BlockList, isIP } from "node:net";

import type { ConnectorsConfig } from "../config/server";
import type { VerifiedPrincipal } from "./context";
import type { PrincipalResolution } from "./oidc-principal";

type TailscaleConfig = Extract<ConnectorsConfig, { humanAuthMode: "tailscale-localapi" }>["tailscale"];
type WhoIsResult = Readonly<{ nodeAddresses: readonly string[]; loginName: string }>;
type WhoIsLookup = (socketPath: string, peerIp: string) => Promise<WhoIsResult>;
/**
 * `trustedProxy` must be true only for requests that arrived on the private trusted-proxy Unix
 * listener, which only Tailscale Serve can reach. TCP requests never carry identity in this mode.
 */
type TailscaleRequest = Readonly<{
  trustedProxy?: boolean;
  /** Informational TCP peer only; it never grants trust. */
  peerAddress?: string;
  headers: Headers;
}>;

const unauthorized: PrincipalResolution = {
  ok: false,
  status: 401,
  title: "Authentication required",
  detail: "A verified Tailscale identity is required.",
};
const forbidden: PrincipalResolution = {
  ok: false,
  status: 403,
  title: "Forbidden",
  detail: "The Tailscale identity is not allowed to use this service.",
};

const ipInSubnet = (address: string, subnet: string): boolean => {
  const [network, prefixText, extra] = subnet.split("/");
  if (network === undefined || extra !== undefined) return false;
  const family = isIP(network);
  const addressFamily = isIP(address);
  if (family === 0 || family !== addressFamily) return false;
  const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) return false;
  try {
    const block = new BlockList();
    block.addSubnet(network, prefix, family === 4 ? "ipv4" : "ipv6");
    return block.check(address, family === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
};

const lookupWhoIs: WhoIsLookup = async (socketPath, peerIp) => {
  const path = `/localapi/v0/whois?addr=${encodeURIComponent(peerIp)}`;
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 65_536) {
          request.destroy(new Error("LocalAPI response too large."));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error("LocalAPI returned an unsuccessful status."));
          return;
        }
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof body !== "object" || body === null) throw new Error("Invalid LocalAPI response.");
          const node = Reflect.get(body, "Node");
          const userProfile = Reflect.get(body, "UserProfile");
          const addresses = typeof node === "object" && node !== null ? Reflect.get(node, "Addresses") : undefined;
          const loginName = typeof userProfile === "object" && userProfile !== null
            ? Reflect.get(userProfile, "LoginName")
            : undefined;
          if (!Array.isArray(addresses) || !addresses.every((item) => typeof item === "string") || typeof loginName !== "string") {
            throw new Error("Invalid LocalAPI identity response.");
          }
          resolve({ nodeAddresses: addresses, loginName });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(2_000, () => request.destroy(new Error("LocalAPI timed out.")));
    request.on("error", reject);
    request.end();
  });
};

export class TailscaleLocalApiPrincipalResolver {
  constructor(
    private readonly config: TailscaleConfig,
    private readonly whoIs: WhoIsLookup = lookupWhoIs,
  ) {}

  async resolve(request: TailscaleRequest): Promise<PrincipalResolution> {
    // X-Forwarded-For is only meaningful when Tailscale Serve itself wrote it, i.e. on the trusted
    // Unix listener. Any TCP peer (including loopback) can forge it, so it is never read for TCP.
    if (request.trustedProxy !== true) return unauthorized;

    const forwardedHeader = request.headers.get("x-forwarded-for");
    if (forwardedHeader === null || forwardedHeader.includes(",")) return unauthorized;
    const clientIp = forwardedHeader.trim();
    if (clientIp === "" || isIP(clientIp) === 0) return unauthorized;

    try {
      const whoIs = await this.whoIs(this.config.localApiSocketPath, clientIp);
      if (
        whoIs.loginName.trim() === "" ||
        !whoIs.nodeAddresses.some((address) => ipInSubnet(clientIp, address))
      ) {
        return unauthorized;
      }
      const loginName = whoIs.loginName.trim().toLowerCase();
      const actorId = this.config.allowedUsers[loginName];
      if (actorId === undefined) return forbidden;
      const principal: VerifiedPrincipal = {
        actorId,
        subject: `tailscale:${loginName}`,
        actorType: "human",
      };
      return { ok: true, principal };
    } catch {
      return unauthorized;
    }
  }
}
