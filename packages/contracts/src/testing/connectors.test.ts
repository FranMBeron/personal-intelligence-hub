import { describe, expect, it } from "vitest";

import * as productionContracts from "../index.js";
import { SourceStatusSchema } from "../connectors.js";
import { UserPreferencesSchema } from "../preferences.js";
import { preferencesFixture, sourceStatusFixture } from "@personal-intelligence-hub/contracts/testing/connectors";

describe("private connector fixtures", () => {
  it("exports schema-valid fictional fixtures only from the testing subpath", () => {
    expect(SourceStatusSchema.parse(sourceStatusFixture()).id).toBe("fictional-source");
    expect(UserPreferencesSchema.parse(preferencesFixture()).version).toBe(1);
    expect(productionContracts).not.toHaveProperty("sourceStatusFixture");
    expect(productionContracts).not.toHaveProperty("preferencesFixture");
  });
});
