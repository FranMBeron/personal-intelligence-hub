import type { IncomingMessage } from "node:http";

export declare const dispatchWithSocketPeer: (
  request: Pick<IncomingMessage, "socket">,
  callback: () => void,
) => void;
