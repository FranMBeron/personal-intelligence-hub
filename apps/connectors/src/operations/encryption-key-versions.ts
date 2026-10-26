import type { ConnectorsConfig } from "../config/private.js";

/**
 * Non-secret encryption key version identifiers required to read data written
 * under the validated provider configuration. Identifiers are namespaced by
 * provider so independent keyrings cannot collide. Key material never leaves
 * the provider configuration; only identifiers already present in the
 * operator-visible configuration are returned.
 */
export const collectConfiguredEncryptionKeyVersions = (
  config: ConnectorsConfig,
): readonly string[] => {
  const versions = new Set<string>();
  const calendar = config.calendar;
  if (calendar !== undefined) {
    for (const keyId of calendar.encryptionKeys.keys()) versions.add(`calendar:${keyId}`);
  }
  return Object.freeze([...versions].sort());
};
