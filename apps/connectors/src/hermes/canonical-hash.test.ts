import { describe, expect, it } from "vitest";

import { canonicalHash, canonicalJson } from "./canonical-hash.js";

describe("canonical hashing", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }))
      .toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("produces the same SHA-256 hex digest for key-order variants only", () => {
    const first = canonicalHash({ parts: [{ kind: "text", text: "hola" }] });
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(canonicalHash({ parts: [{ text: "hola", kind: "text" }] })).toBe(first);
    expect(canonicalHash({ parts: [{ kind: "text", text: "hola " }] })).not.toBe(first);
  });

  it("hashes UTF-8 text exactly", () => {
    expect(canonicalHash({ text: "Analizá" })).not.toBe(canonicalHash({ text: "Analiza" }));
  });

  it("rejects values JSON cannot represent faithfully", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("hermes_canonical_value_invalid");
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("hermes_canonical_value_invalid");
    expect(() => canonicalJson({ value: () => 1 })).toThrow("hermes_canonical_value_invalid");
    expect(() => canonicalJson(new Date(0))).toThrow("hermes_canonical_value_invalid");
  });
});
