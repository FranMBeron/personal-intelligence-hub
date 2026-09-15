import "server-only";

const defaultApiInternalUrl = "http://127.0.0.1:3001";

export const serverConfig = Object.freeze({
  apiInternalUrl: new URL(
    process.env.PIH_API_INTERNAL_URL ?? defaultApiInternalUrl,
  ).toString(),
});
