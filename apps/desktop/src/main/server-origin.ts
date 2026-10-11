export function normalizeServerOrigin(
  input: string,
  options: { allowInsecureLoopback: boolean },
): URL {
  const url = new URL(input);
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";

  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && options.allowInsecureLoopback && isLoopback)
  ) {
    throw new Error("Use HTTPS, or explicitly allow HTTP loopback in development");
  }

  if (url.username || url.password) {
    throw new Error("Server URLs must not contain credentials");
  }

  if (url.pathname !== "/" || url.search || url.hash || /[?#]/u.test(url.href)) {
    throw new Error("Server URLs must contain only an origin");
  }

  return new URL(url.origin);
}
