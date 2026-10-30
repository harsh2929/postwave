import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shellStyles = readFileSync(
  new URL("../../styles/shell-components.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = shellStyles.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match) throw new Error(`Missing ${selector} shell rule`);
  return match[1];
}

describe("desktop shell chrome layout", () => {
  it("reserves one native inset without shortening either shell column", () => {
    expect(ruleBody(".app-shell")).toMatch(
      /padding-top:\s*var\(--pw-titlebar-h\)/,
    );
    expect(ruleBody(".app-shell")).toMatch(/overflow:\s*hidden/);
    expect(ruleBody(".sidebar")).not.toMatch(/padding-top:/);
    expect(ruleBody(".main")).not.toMatch(/padding-top:/);
  });
});
