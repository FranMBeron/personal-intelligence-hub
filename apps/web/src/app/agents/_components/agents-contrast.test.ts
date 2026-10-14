// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A deliberately small cascade: real stylesheet rules (globals.css then agents.css), selector
 * matching via jsdom `matches`, specificity + source order, and only the media queries a
 * desktop pointer satisfies. Enough to resolve the colours of the "Conversar con" button.
 */
type Rule = { selectors: string[]; decls: Map<string, string>; order: number };

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const ACTIVE_MEDIA = new Set(["(hover:hover) and (pointer:fine)", "(hover: hover) and (pointer: fine)"]);

const splitTopLevel = (text: string, separator: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === separator && depth === 0) { parts.push(current); current = ""; } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
};

const parseRules = (css: string, startOrder: number): Rule[] => {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: Rule[] = [];
  const walk = (text: string, active: boolean) => {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf("{", index);
      if (open === -1) return;
      const prelude = text.slice(index, open).trim();
      let depth = 1;
      let close = open + 1;
      for (; close < text.length && depth > 0; close += 1) {
        if (text[close] === "{") depth += 1;
        if (text[close] === "}") depth -= 1;
      }
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@media")) walk(body, active && ACTIVE_MEDIA.has(prelude.slice(6).trim()));
      else if (prelude.startsWith("@")) { /* keyframes, container queries: no colour rules for the button */ }
      else if (active) {
        const decls = new Map<string, string>();
        for (const decl of splitTopLevel(body, ";")) {
          const colon = decl.indexOf(":");
          if (colon !== -1) decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
        }
        rules.push({ selectors: splitTopLevel(prelude, ","), decls, order: startOrder + rules.length });
      }
      index = close;
    }
  };
  walk(source, true);
  return rules;
};

const specificity = (selector: string): number => {
  const ids = (selector.match(/#[\w-]+/gu) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/gu) ?? []).length;
  const types = (selector.replace(/\[[^\]]+\]|:[\w-]+|[.#][\w-]+/gu, " ").match(/(^|[\s>+~])[a-z][\w-]*/gu) ?? []).length;
  return ids * 10_000 + classes * 100 + types;
};

const globals = parseRules(read("../../globals.css"), 0);
const agents = parseRules(read("./agents.css"), 100_000);
// Route CSS chunks are not guaranteed to load after globals.css, so check both orders.
const agentsFirst = parseRules(read("./agents.css"), -100_000);
const tokens = new Map([...globals.filter((rule) => rule.selectors.includes(":root")).flatMap((rule) => [...rule.decls])]);

const resolve = (value: string): string => {
  const match = /^var\((--[\w-]+)\)$/u.exec(value.trim());
  return match === null ? value.trim() : resolve(tokens.get(match[1]!) ?? "");
};

const effective = (element: Element, hover: boolean, property: "color" | "background", order: "globals-first" | "agents-first") => {
  let winner: { weight: number; value: string } | undefined;
  for (const rule of [...globals, ...(order === "globals-first" ? agents : agentsFirst)]) {
    const value = rule.decls.get(property) ?? (property === "background" ? rule.decls.get("background-color") : undefined);
    if (value === undefined) continue;
    for (const selector of rule.selectors) {
      if (selector.includes(":hover") && !hover) continue;
      const testable = selector.replace(/:hover/gu, "");
      if (testable.includes(":") && !/:(is|where|not)\(/u.test(testable)) continue;
      let matches = false;
      try { matches = element.matches(testable); } catch { matches = false; }
      if (!matches) continue;
      const weight = specificity(selector) * 1_000_000 + rule.order;
      if (winner === undefined || weight > winner.weight) winner = { weight, value };
    }
  }
  return resolve(winner?.value ?? "");
};

const luminance = (hex: string): number => {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(hex);
  const normalized = hex.toLowerCase() === "white" ? "#ffffff" : short === null ? hex : `#${short.slice(1).map((c) => c + c).join("")}`;
  const match = /^#([0-9a-f]{6})$/iu.exec(normalized);
  if (match === null) throw new Error(`Unresolvable colour: ${hex}`);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

const conversationButton = (pressed: boolean) => {
  document.body.innerHTML = `<article class="agent-card surface"><div class="agent-conversation"><button class="button button--quiet" type="button" aria-pressed="${pressed}">Conversar con Agente</button></div></article>`;
  return document.querySelector("button")!;
};

describe("Conversar con agent button contrast", () => {
  it("helper sanity: the reported pair is below the threshold", () => {
    expect(contrast("#536159", "#1f4031")).toBeLessThan(2);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 0);
  });

  it.each([
    ["normal", false, false],
    ["hover", false, true],
    ["pressed", true, false],
    ["pressed + hover", true, true],
  ].flatMap(([name, pressed, hover]) => (["globals-first", "agents-first"] as const).map((order) => [name, pressed, hover, order] as const)))(
    "%s state (pressed=%s, hover=%s, %s) reaches 4.5:1", (_name, pressed, hover, order) => {
    const button = conversationButton(pressed as boolean);
    const color = effective(button, hover as boolean, "color", order);
    const background = effective(button, hover as boolean, "background", order);
    expect(contrast(color, background), `${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
  });
});
