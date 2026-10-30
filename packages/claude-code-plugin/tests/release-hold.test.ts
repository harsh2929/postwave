// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const HOLD_CODE = "mcp_distribution_release_held";

describe("Claude Code package release hold", () => {
  it("fails closed before any install mutation or credential setup", () => {
    const cli = read("src/cli.ts");
    const installBody = cli.slice(
      cli.indexOf("function install()"),
      cli.indexOf("async function uninstall"),
    );

    expect(installBody).toContain("MCP_RELEASE_HOLD_CODE");
    expect(installBody).toContain("process.exitCode = 1");
    expect(installBody).not.toMatch(/mkdirSync|cpSync|writeFileSync|POSTWAVE_API_KEY/);
    expect(cli).not.toMatch(/claude\s+mcp\s+add|@postwave\/mcp-server/);
  });

  it("ships no MCP runtime dependency or runnable setup guidance", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
    };
    const guidance = [
      read("README.md"),
      read("claude-md/POSTWAVE.md"),
      read("CONTRIBUTING.md"),
    ].join("\n");

    expect(manifest.dependencies).not.toHaveProperty("@postwave/mcp-server");
    expect(guidance).toContain(HOLD_CODE);
    expect(guidance).not.toMatch(
      /(?:npx|npm\s+(?:install|i)|pnpm\s+(?:add|dlx)|claude\s+mcp\s+add).{0,100}(?:claude-code-plugin|mcp-server|postwave-cc-install)/i,
    );
    expect(guidance).not.toMatch(/POSTWAVE_API_KEY|pw_(?:live|test|xxx)/i);
  });

  it("marks every packaged skill as held and non-invocable", () => {
    const skillRoot = new URL("../skills/", import.meta.url);
    const skillFiles = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => read(`skills/${entry.name}/SKILL.md`));

    expect(skillFiles).toHaveLength(7);
    for (const skill of skillFiles) {
      expect(skill).toContain(HOLD_CODE);
      expect(skill).toContain("disable-model-invocation: true");
      expect(skill).toMatch(/non-runnable source candidate/i);
      expect(skill).not.toMatch(/\bCall `|\bRun `|POSTWAVE_API_KEY|pw_live_/i);
    }
  });
});
