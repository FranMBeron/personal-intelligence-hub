import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { posix } from "node:path";

const peerStorageSymbol = Symbol.for("pih.web.immediate-peer-address");
const peerStorage = globalThis[peerStorageSymbol] ??= new AsyncLocalStorage();

/**
 * Peer marker for requests accepted on the private trusted-proxy Unix listener. It is not an IP
 * address, and TCP peers are normalized to IP addresses only, so no TCP client can produce it.
 */
export const TRUSTED_PROXY_PEER = "unix:trusted-proxy";

const normalizePeerAddress = (address) => {
  if (typeof address !== "string") return undefined;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return isIP(normalized) === 0 ? undefined : normalized;
};

/** Dispatches a request from the TCP listener with only its IP socket peer as context. */
export const dispatchWithSocketPeer = (request, callback) =>
  peerStorage.run(normalizePeerAddress(request.socket?.remoteAddress), callback);

/**
 * Dispatches a request from the trusted-proxy Unix listener. A socket that reports an IP peer
 * is a TCP socket and is never marked as trusted, even if wired to this helper by mistake.
 */
export const dispatchFromTrustedProxyListener = (request, callback) => {
  const remoteAddress = request.socket?.remoteAddress;
  if (remoteAddress !== undefined) {
    peerStorage.run(normalizePeerAddress(remoteAddress), callback);
    return;
  }
  peerStorage.run(TRUSTED_PROXY_PEER, callback);
};

const maximumSocketPathBytes = 100;

const assertTrustedProxySocketPath = (path) => {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    !path.endsWith(".sock") ||
    posix.basename(path) === ".sock" ||
    Buffer.byteLength(path, "utf8") > maximumSocketPathBytes
  ) {
    throw new Error("PIH_WEB_TRUSTED_PROXY_SOCKET must be a normalized absolute *.sock path of at most 100 bytes.");
  }
};

const usesTailscaleIdentity = (environment) =>
  environment.AUTH_MODE === "tailscale" ||
  (environment.CONNECTORS_ENABLED === "true" && environment.CONNECTORS_HUMAN_AUTH_MODE === "tailscale-localapi");

/**
 * Returns the trusted-proxy socket path, or undefined when no Tailscale identity mode is configured.
 * Partial or mixed configuration throws so the server never starts with ambiguous proxy trust.
 */
export const trustedProxySocketPathFromEnvironment = (environment) => {
  if (environment.CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR !== undefined) {
    throw new Error("CONNECTORS_TAILSCALE_TRUSTED_PROXY_CIDR was removed; set PIH_WEB_TRUSTED_PROXY_SOCKET and point Tailscale Serve at that Unix socket.");
  }
  const path = environment.PIH_WEB_TRUSTED_PROXY_SOCKET;
  const tailscale = usesTailscaleIdentity(environment);
  if (path === undefined) {
    if (tailscale) throw new Error("Tailscale identity requires PIH_WEB_TRUSTED_PROXY_SOCKET.");
    return undefined;
  }
  if (!tailscale) {
    throw new Error("PIH_WEB_TRUSTED_PROXY_SOCKET is only valid with a Tailscale identity mode.");
  }
  assertTrustedProxySocketPath(path);
  return path;
};

const errorCode = (error) =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

const lstatOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;

const socketAcceptsConnections = (path) => new Promise((resolve, reject) => {
  const socket = createConnection({ path });
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", (error) => {
    socket.destroy();
    const code = errorCode(error);
    if (code === "ECONNREFUSED" || code === "ENOENT") resolve(false);
    else reject(error);
  });
});

const processUid = () => {
  if (typeof process.getuid !== "function") {
    throw new Error("The trusted proxy socket requires a POSIX process user.");
  }
  return process.getuid();
};

const removeStaleSocket = async (path, uid) => {
  const existing = await lstatOrNull(path);
  if (existing === null) return;
  if (existing.isSymbolicLink() || !existing.isSocket() || existing.uid !== uid) {
    throw new Error("Refusing to replace a trusted proxy socket path that is not a socket owned by this process user.");
  }
  if (await socketAcceptsConnections(path)) {
    throw new Error("The trusted proxy socket is already active in another process.");
  }
  const beforeUnlink = await lstatOrNull(path);
  if (beforeUnlink === null) return;
  if (!sameInode(existing, beforeUnlink) || beforeUnlink.isSymbolicLink() || !beforeUnlink.isSocket()) {
    throw new Error("Refusing to replace a trusted proxy socket path that changed during stale-socket validation.");
  }
  await unlink(path);
};

const setUmask = (mask) => {
  try {
    return process.umask(mask);
  } catch {
    // Worker threads cannot change the umask; the owner-only directory and chmod below still apply.
    return undefined;
  }
};

/**
 * Listens on the private trusted-proxy Unix socket. The parent directory must already exist,
 * be a real directory owned by this process user and grant no group/other access. A stale socket
 * owned by this user is replaced; anything else at the path (file, symlink, active socket) is fatal.
 */
export const listenOnTrustedProxySocket = async (server, path) => {
  assertTrustedProxySocketPath(path);
  const uid = processUid();
  const directory = await lstatOrNull(posix.dirname(path));
  if (
    directory === null ||
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error("The trusted proxy socket directory must be an existing owner-only (0700) directory owned by the web process user.");
  }
  await removeStaleSocket(path, uid);

  const previousMask = setUmask(0o177);
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(path);
    });
  } finally {
    if (previousMask !== undefined) setUmask(previousMask);
  }

  const created = await lstat(path);
  if (created.isSymbolicLink() || !created.isSocket() || created.uid !== uid) {
    server.close();
    throw new Error("The trusted proxy socket was replaced while it was being created.");
  }
  await chmod(path, 0o600);
  const secured = await lstat(path);
  if (!sameInode(created, secured) || !secured.isSocket() || (secured.mode & 0o777) !== 0o600) {
    server.close();
    throw new Error("The trusted proxy socket permissions could not be restricted.");
  }
};
