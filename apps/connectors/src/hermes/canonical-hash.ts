import { createHash } from "node:crypto";

const invalid = (): never => { throw new Error("hermes_canonical_value_invalid"); };

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : invalid();
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonicalize(item)).join(",") + "}";
  }
  return invalid();
};

/** Deterministic JSON: object keys sorted recursively, array order preserved, non-JSON values rejected. */
export const canonicalJson = (value: unknown): string => canonicalize(value);

/** SHA-256 hex digest of the canonical UTF-8 JSON encoding. */
export const canonicalHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
