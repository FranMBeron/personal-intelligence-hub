import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

/**
 * Marker recorded by the peer server for requests accepted on the private trusted-proxy Unix
 * listener (see peer-http-server.mjs). It is not an IP address, so no TCP peer can produce it.
 */
export const TRUSTED_PROXY_PEER = "unix:trusted-proxy";

const peerStorageSymbol = Symbol.for("pih.web.immediate-peer-address");
type PeerStorage = AsyncLocalStorage<string | undefined>;
type PeerGlobal = typeof globalThis & Record<symbol, PeerStorage | undefined>;

const peerStorage = (() => {
  const global = globalThis as PeerGlobal;
  return (global[peerStorageSymbol] ??= new AsyncLocalStorage<string | undefined>());
})();

const normalizePeerAddress = (address: string | undefined): string | undefined => {
  if (address === undefined) return undefined;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return isIP(normalized) === 0 ? undefined : normalized;
};

/** Returns the immediate TCP peer IP, or TRUSTED_PROXY_PEER for the trusted-proxy Unix listener. */
export const getImmediatePeerAddress = (): string | undefined => peerStorage.getStore();

export const isTrustedProxyPeer = (peer: string | undefined): boolean => peer === TRUSTED_PROXY_PEER;

export const withImmediatePeerAddress = <T>(address: string | undefined, callback: () => T): T =>
  peerStorage.run(normalizePeerAddress(address), callback);

/** Runs `callback` as if the request had arrived on the trusted-proxy Unix listener. */
export const withTrustedProxyPeer = <T>(callback: () => T): T =>
  peerStorage.run(TRUSTED_PROXY_PEER, callback);
