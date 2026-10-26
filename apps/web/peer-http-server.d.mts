import type { IncomingMessage, Server } from "node:http";

export declare const TRUSTED_PROXY_PEER: "unix:trusted-proxy";

export declare const dispatchWithSocketPeer: (
  request: Pick<IncomingMessage, "socket">,
  callback: () => void,
) => void;

export declare const dispatchFromTrustedProxyListener: (
  request: Pick<IncomingMessage, "socket">,
  callback: () => void,
) => void;

export declare const trustedProxySocketPathFromEnvironment: (
  environment: Readonly<Record<string, string | undefined>>,
) => string | undefined;

export declare const listenOnTrustedProxySocket: (server: Server, path: string) => Promise<void>;
