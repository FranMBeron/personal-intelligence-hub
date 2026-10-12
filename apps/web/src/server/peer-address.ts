import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

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

export const getImmediatePeerAddress = (): string | undefined => peerStorage.getStore();

export const withImmediatePeerAddress = <T>(address: string | undefined, callback: () => T): T =>
  peerStorage.run(normalizePeerAddress(address), callback);
