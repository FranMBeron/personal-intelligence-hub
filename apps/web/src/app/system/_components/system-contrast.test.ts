// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./system.css", import.meta.url)), "utf8");

const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};
const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

describe("Sistema component palette", () => {
  const tokens = Object.fromEntries([...css.matchAll(/--(system-[a-z]+):\s*(#[0-9a-f]{6})/gu)].map((match) => [match[1]!, match[2]!]));

  it("declares every text token", () => {
    expect(Object.keys(tokens).toSorted()).toEqual(["system-danger", "system-muted", "system-positive", "system-warning"]);
  });

  it.each(["#ffffff", "#f6f3ed", "#f5e1d8", "#f3ede2", "#e3eee6"])("keeps text at least 4.5:1 on %s", (background) => {
    for (const color of Object.values(tokens)) expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
  });
});
