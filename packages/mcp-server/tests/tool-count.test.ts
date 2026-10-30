// SPDX-License-Identifier: MIT
//
// Candidate-source drift guard. These assertions bind the checked-out source,
// README candidate label, and web candidate catalogue only. They deliberately
// do not claim parity with the npm registry artifact or a deployed service;
// publication parity requires an installed-artifact release probe.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { allTools, toolsForProfile } from "../src/tools/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(here, "..", "README.md"), "utf8");
const webCatalog = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "apps", "web", "src", "lib", "mcp-tools.json"),
    "utf8",
  ),
) as { name: string; category: string; description: string }[];

describe("candidate source catalogue counts stay explicitly qualified", () => {
  const tools = allTools({} as never);

  it("README candidate count matches allTools().length without implying publication parity", () => {
    const m = readme.match(
      /repository candidate contains (\d+) tool definitions, \d+ resources/,
    );
    expect(
      m,
      "README must label the exact count as a repository candidate",
    ).not.toBeNull();
    expect(Number(m![1])).toBe(tools.length);
    expect(readme).toContain("does not identify one reproducible catalogue");
    expect(readme).toContain(
      "not\nthe installed npm artifact or a deployed service",
    );
  });

  it("README category count matches the number of tool families", () => {
    // Count the `...xTools(client)` spreads in allTools — one per category.
    const indexSrc = readFileSync(
      join(here, "..", "src", "tools", "index.ts"),
      "utf8",
    );
    const body = indexSrc.slice(indexSrc.indexOf("export function allTools"));
    const categories = (body.match(/\.\.\.[a-zA-Z]+Tools\(client\)/g) ?? [])
      .length;
    const m = readme.match(
      /Candidate source snapshot: (\d+) definitions across (\d+) tool families/,
    );
    expect(
      m,
      "README must label category count as a candidate source snapshot",
    ).not.toBeNull();
    expect(Number(m![1])).toBe(tools.length);
    expect(Number(m![2])).toBe(categories);
  });

  it("every tool name is unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("can contain an agent to the template catalogue without changing the full registry", () => {
    const scoped = toolsForProfile({} as never, "templates");
    expect(scoped.length).toBeGreaterThan(30);
    expect(
      scoped.every((tool) => tool.name.startsWith("campaign_template_")),
    ).toBe(true);
    expect(toolsForProfile({} as never, "full").length).toBe(tools.length);
    expect(() => toolsForProfile({} as never, "unknown")).toThrow(
      "Unsupported MCP tool profile",
    );
  });

  it("the web candidate catalog exactly matches this source registry", () => {
    expect(webCatalog.map((tool) => tool.name)).toEqual(
      tools.map((tool) => tool.name),
    );
    // campaignTools and campaignTemplateTools intentionally share the public
    // `campaigns` category, so the web catalogue has one fewer category label
    // than the source registry has tool-family spreads.
    expect(new Set(webCatalog.map((tool) => tool.category)).size).toBe(31);
    expect(webCatalog.every((tool) => tool.description.trim().length > 0)).toBe(
      true,
    );
  });
});
