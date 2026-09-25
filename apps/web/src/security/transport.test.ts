import { describe, expect, it } from "vitest";

import { strictTransportSecurityForOrigin } from "./transport";

describe("strictTransportSecurityForOrigin", () => {
  it("enables HSTS only for an explicitly HTTPS public origin", () => {
    expect(strictTransportSecurityForOrigin("https://pih.example.test")).toBe(
      "max-age=31536000",
    );
    expect(strictTransportSecurityForOrigin("http://127.0.0.1:3000")).toBeUndefined();
    expect(strictTransportSecurityForOrigin(undefined)).toBeUndefined();
    expect(strictTransportSecurityForOrigin("not a url")).toBeUndefined();
  });
});
