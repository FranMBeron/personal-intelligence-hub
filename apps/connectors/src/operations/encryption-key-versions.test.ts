import { describe, expect, it } from "vitest";

import { loadConnectorsConfig } from "../config/private.js";
import { providerConfigNamespaces } from "../providers.js";
import {
  fictionalCalendarEnvironment,
  fictionalHermesEnvironment,
  fictionalOperatorEnvironment,
} from "../../test/operations/fixtures.js";
import { collectConfiguredEncryptionKeyVersions } from "./encryption-key-versions.js";

describe("collectConfiguredEncryptionKeyVersions", () => {
  it("derives sorted non-secret key version IDs from the validated Calendar keyring", () => {
    const environment = fictionalOperatorEnvironment("/var/lib/fictional/connectors.sqlite", {
      ...fictionalCalendarEnvironment(),
      ...fictionalHermesEnvironment("/var/lib/fictional/uploads"),
    });
    const config = loadConnectorsConfig(environment, providerConfigNamespaces);
    const versions = collectConfiguredEncryptionKeyVersions(config);
    expect(versions).toEqual(["calendar:fictional-key-1", "calendar:fictional-key-2"]);
    expect(Object.isFrozen(versions)).toBe(true);
    const serialized = JSON.stringify(versions);
    for (const [name, value] of Object.entries(environment)) {
      if (/KEY(S_JSON)?$|SECRET|CREDENTIALS/u.test(name)) expect(serialized).not.toContain(value);
    }
  });

  it("returns no versions when no provider keyring is configured", () => {
    const config = loadConnectorsConfig(
      fictionalOperatorEnvironment("/var/lib/fictional/connectors.sqlite"),
      providerConfigNamespaces,
    );
    expect(collectConfiguredEncryptionKeyVersions(config)).toEqual([]);
  });
});
