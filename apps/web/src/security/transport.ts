export const strictTransportSecurityForOrigin = (
  publicOrigin: string | undefined,
): string | undefined => {
  if (publicOrigin === undefined) return undefined;
  try {
    return new URL(publicOrigin).protocol === "https:"
      ? "max-age=31536000"
      : undefined;
  } catch {
    return undefined;
  }
};
