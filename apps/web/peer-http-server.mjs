import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

const peerStorageSymbol = Symbol.for("pih.web.immediate-peer-address");
const peerStorage = globalThis[peerStorageSymbol] ??= new AsyncLocalStorage();

const normalizePeerAddress = (address) => {
  if (typeof address !== "string") return undefined;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return isIP(normalized) === 0 ? undefined : normalized;
};

export const dispatchWithSocketPeer = (request, callback) =>
  peerStorage.run(normalizePeerAddress(request.socket?.remoteAddress), callback);
