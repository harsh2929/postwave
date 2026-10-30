// SPDX-License-Identifier: AGPL-3.0-only
//
// Route 39 release-claim containment is intentionally repo-wide. A page-only
// assertion missed OG metadata, search documents, package READMEs, a publish
// plan, plugin CLI, desktop setup, and executable demo scripts. This test
// names every active claim family and also sweeps high-signal forbidden copy
// across the live web source tree.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");
const WEB = join(REPO, "apps/web/src");

function source(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

function sourceTree(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["__tests__", "node_modules"].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceTree(path, out);
    else if (/\.(?:ts|tsx)$/u.test(path)) out.push(path);
  }
  return out;
}

const ACTIVE_PUBLIC_CLAIMS = [
  "apps/web/src/app/(marketing)/mcp/page.tsx",
  "apps/web/src/app/(marketing)/mcp/opengraph-image.tsx",
  "apps/web/src/app/(marketing)/developers/page.tsx",
  "apps/web/src/app/(marketing)/developers/opengraph-image.tsx",
  "apps/web/src/app/(marketing)/integrations/page.tsx",
  "apps/web/src/lib/integrations.ts",
  "apps/web/src/app/(marketing)/forms/page.tsx",
  "apps/web/src/app/(marketing)/voice/page.tsx",
  "apps/web/src/app/(marketing)/automations/page.tsx",
  "apps/web/src/app/(docs)/docs/skills/page.tsx",
  "apps/web/src/app/(docs)/docs/skills/[skill]/page.tsx",
  "apps/web/src/lib/docs/search.server.ts",
  "apps/web/src/app/forge/page.tsx",
  "apps/web/src/app/forge/docs/page.tsx",
  "apps/web/src/app/forge/layout.tsx",
  "apps/web/src/app/forge/motion-preview/page.tsx",
  "apps/web/src/app/(marketing)/page.tsx",
  "apps/web/src/app/(marketing)/features/page.tsx",
  "apps/web/src/lib/docs/popular.ts",
  "apps/web/src/app/(marketing)/changelog/page.tsx",
  "apps/web/src/app/changelog.xml/route.ts",
  "apps/web/src/app/(marketing)/docs/page.tsx",
  "apps/web/src/app/(marketing)/api-docs/page.tsx",
  "apps/web/src/components/marketing/product-menu.tsx",
  "apps/web/src/app/(marketing)/vs/page.tsx",
  "apps/web/src/app/(marketing)/vs/sendy/page.tsx",
  "apps/web/src/app/(marketing)/vs/beehiiv/page.tsx",
  "apps/web/src/app/(marketing)/vs/mailchimp/page.tsx",
  "apps/web/src/app/(marketing)/vs/substack/page.tsx",
  "apps/web/src/app/(marketing)/vs/mailerlite/page.tsx",
  "apps/web/src/app/(marketing)/vs/convertkit/page.tsx",
  "apps/web/src/app/(docs)/docs/getting-started/page.tsx",
  "apps/web/src/app/(docs)/docs/quickstart/page.tsx",
  "apps/web/src/app/(public)/llms.txt/route.ts",
  "apps/web/src/app/(marketing)/migrate-anywhere/page.tsx",
  "apps/web/src/app/(dashboard)/app/templates/[id]/page.tsx",
] as const;

const CURRENT_SOURCE_TOOL_COUNT = (
  JSON.parse(source("apps/web/src/lib/mcp-tools.json")) as unknown[]
).length;

describe("Route 39 active MCP and agent claims", () => {
  it("routes every public claim family through release/source provenance", () => {
    for (const path of ACTIVE_PUBLIC_CLAIMS) {
      const text = source(path);
      expect(
        /release[-_ ]held|release hold|source[-_ ]candidate|source (?:definition|inventory|illustration|milestone|concept)|unsupported private|qualification|MCP_RELEASE_|AGENT_INTERACTIVE_RELEASE_/iu.test(
          text,
        ),
        `${path} has no release/source boundary`,
      ).toBe(true);
    }
  });

  it("rejects alternate live install, hosted, full-surface, and works-now copy", () => {
    const combined = sourceTree(WEB)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const forbidden of [
      /Now in Claude Code/iu,
      /Run it from Claude Code/iu,
      /Full MCP \+ REST control/iu,
      /✓\s*stdio\s*\+\s*HTTP/iu,
      /MCP\s*&\s*Agents\s*=\s*Agent-native tools/iu,
      /Connect Claude\s*\/\s*Cursor\s*\/\s*ChatGPT via MCP/iu,
      /Domain agents shipped/iu,
      /all but four reviewed model-output projections/iu,
      /22 first-class agent tools/iu,
      /211-tool(?: MCP)? surface/iu,
      /Every plan includes[^.\n]{0,80}agent surface/iu,
      /Moosewave covers the agent send side/iu,
      /mcp\.postwave\.com/iu,
      /claude mcp add/iu,
      /npx\s+(?:-y\s+)?@postwave\/mcp-server/iu,
    ]) {
      expect(combined, `forbidden live web claim: ${forbidden}`).not.toMatch(
        forbidden,
      );
    }
  });

  it("keeps the whole in-app agent family held in shared and consumer copy", () => {
    const status = source("apps/web/src/lib/mcp-release-status.ts");
    expect(status).toContain('"agent_interactive_release_held"');
    expect(status).toContain("entire /api/v1/ai-agent/* family");
    expect(status).toContain("private, no-store 503");
    expect(status).toContain("before session storage");
    expect(status).not.toMatch(/four reviewed/iu);
    expect(status).toContain("no working preview is available");

    const consumers = [
      source("apps/web/src/app/(marketing)/developers/page.tsx"),
      source("apps/web/src/app/(marketing)/mcp/page.tsx"),
      source("apps/web/src/app/forge/page.tsx"),
      source("apps/web/src/app/forge/docs/page.tsx"),
      source("apps/web/src/app/(marketing)/changelog/page.tsx"),
      source("apps/web/src/app/changelog.xml/route.ts"),
    ].join("\n");
    expect(consumers).toContain("AGENT_INTERACTIVE_RELEASE_STATUS_COPY");
    expect(consumers).not.toMatch(/No supported runtime is mounted\. Yes/iu);
  });

  it("qualifies per-skill metadata, visible headers, examples, and search", () => {
    const detail = source(
      "apps/web/src/app/(docs)/docs/skills/[skill]/page.tsx",
    );
    expect(detail).toContain("Release-held MCP source candidate");
    expect(detail).toContain('role="note"');
    expect(detail).toContain("mutable repository schema");
    expect(detail).toContain("Non-executable source-schema illustration");

    const search = source("apps/web/src/lib/docs/search.server.ts");
    expect(search).toContain("release-held MCP source candidate");
    expect(search).toContain("no supported install, hosted connector");
  });

  it("keeps counts tied to mutable source or immutable artifact provenance", () => {
    for (const path of [
      "README.md",
      "packages/mcp-server/README.md",
      "apps/web/src/app/(marketing)/changelog/page.tsx",
      "apps/web/src/app/(marketing)/mcp/page.tsx",
      "apps/web/src/app/forge/page.tsx",
    ]) {
      const text = source(path);
      if (
        [133, 211, CURRENT_SOURCE_TOOL_COUNT].some((count) =>
          new RegExp(`\\b${count}\\b`, "u").test(text),
        )
      ) {
        expect(text, `${path} count lacks source/artifact provenance`).toMatch(
          /source|artifact/iu,
        );
      }
    }
    expect(
      source("apps/web/src/components/marketing/product-shot.tsx"),
    ).toContain('["Qualification", "Release-held"]');
  });
});

describe("Route 39 shipped-package and execution-path containment", () => {
  it("holds both MCP distributions at manifest and release-plan boundaries", () => {
    for (const path of [
      "packages/mcp-server/package.json",
      "packages/claude-code-plugin/package.json",
    ]) {
      const manifest = JSON.parse(source(path)) as {
        private?: boolean;
        publishConfig?: unknown;
      };
      expect(manifest.private, path).toBe(true);
      expect(manifest.publishConfig, path).toBeUndefined();
    }
    const plan = source("scripts/release/npm-release-plan.mjs");
    expect(plan).toContain("mcp_distribution_release_held");
    expect(plan).toContain('"mcp-server"');
    expect(plan).toContain('"claude-code-plugin"');
    const runbook = source("packages/PUBLISH.md");
    expect(runbook).toContain("Both manifests are private");
    expect(runbook).toContain("explicit manual selection fails");
  });

  it("publishes no runnable MCP setup guidance from current package docs", () => {
    const guidance = [
      "packages/mcp-server/README.md",
      "packages/mcp-server/SECURITY.md",
      "packages/mcp-server/CONTRIBUTING.md",
      "packages/mcp-server/CHANGELOG.md",
      "packages/email-react/README.md",
      "packages/schema/README.md",
      "packages/claude-code-plugin/README.md",
      "packages/claude-code-plugin/claude-md/POSTWAVE.md",
    ]
      .map(source)
      .join("\n");
    expect(guidance).not.toMatch(/claude mcp add/iu);
    expect(guidance).not.toMatch(/npx\s+(?:-y\s+)?@postwave\/mcp-server/iu);
    expect(guidance).not.toMatch(/mcp\.postwave\.com/iu);
    expect(guidance).toContain("unsupported private source");
    expect(guidance).not.toMatch(/mutable repository is a\s+non-runnable/iu);
    expect(guidance).not.toMatch(/agents can invoke directly/iu);
  });

  it("keeps inert examples and plugin/demo entry points fail-closed", () => {
    for (const path of [
      "packages/mcp-server/examples/claude-code-config.json",
      "packages/mcp-server/examples/claude-desktop-config.json",
      "packages/mcp-server/examples/cursor-config.json",
    ]) {
      const example = JSON.parse(source(path)) as Record<string, unknown>;
      expect(
        (example.releaseHold as Record<string, unknown> | undefined)?.runnable,
        path,
      ).toBe(false);
      expect(JSON.stringify(example), path).not.toMatch(
        /POSTWAVE_API_KEY|@postwave\/mcp-server|mcp\.postwave\.com/iu,
      );
    }
    const plugin = source("packages/claude-code-plugin/src/cli.ts");
    expect(plugin).toContain("MCP_RELEASE_HOLD_CODE");
    expect(
      source("packages/claude-code-plugin/src/release-status.ts"),
    ).toContain("mcp_distribution_release_held");
    expect(plugin).not.toContain("@postwave/mcp-server");
    for (const path of [
      "scripts/demo/agent-mcp-demo.sh",
      "scripts/demo/agent-chat-demo.sh",
    ]) {
      const demo = source(path);
      expect(demo).toContain("mcp_distribution_release_held");
      expect(demo).toContain("exit 78");
      expect(demo).not.toMatch(
        /curl|POSTWAVE_API_KEY|ANTHROPIC_API_KEY|\/api\/v1\/(?:mcp\/rpc|ai-agent)/u,
      );
    }
  });

  it("keeps desktop setup structurally held without denying private source evaluation", () => {
    const setup = source(
      "apps/desktop/src/components/mcp/McpConnectionSetup.tsx",
    );
    expect(setup).toContain('apiKey=""');
    expect(setup).toContain("transfersEnabled={false}");
    const summary = source(
      "apps/desktop/src/components/ai/McpAgentSummary.tsx",
    );
    expect(summary).toContain("unsupported private-source evaluation only");
    expect(summary).not.toContain(
      "Catalogue exploration is source-only and non-runnable",
    );
    expect(source("apps/desktop/src/pages/PostwaveAI.tsx")).toContain(
      "Review release-held MCP source candidate",
    );
  });

  it("keeps mobile MCP telemetry advisory and explicitly non-billing", () => {
    const mobile = [
      source("apps/mobile/src/components/mcp/McpActivityScreen.tsx"),
      source("apps/mobile/src/components/mcp/McpVerdictCard.tsx"),
      source("apps/mobile/src/lib/mcpActivity.ts"),
    ].join("\n");
    for (const phrase of [
      "best-effort",
      "droppable",
      "caller-controlled",
      "non-billing",
      "Recorded success rate",
      "retained row",
    ]) {
      expect(mobile).toContain(phrase);
    }
    expect(mobile).not.toMatch(/Billable cost|All calls succeeded/iu);
  });

  it("keeps the root SDK example outside the held agent-control claim", () => {
    const readme = source("README.md");
    expect(readme).toContain("An ordinary SDK read");
    expect(readme).toContain("not an agent-control loop");
    expect(readme).not.toContain("The same loop in TypeScript");
    expect(readme).not.toMatch(/Sandbox a dry run|Stream live events/iu);
  });

  it("keeps the backend MCP integration tile source-only", () => {
    const catalog = source("apps/api/internal/integrations/catalog.go");
    expect(catalog).toContain("Release-held MCP source candidate");
    expect(catalog).not.toContain(
      "Expose Moosewave tools safely to agent clients through the MCP surface",
    );
    const emitters = [
      source("apps/api/internal/integrations/handlers.go"),
      source("apps/api/internal/integrations/recipes.go"),
      source("apps/api/internal/integrations/contracts.go"),
      source("apps/api/internal/integrations/stacks.go"),
    ].join("\n");
    expect(emitters).not.toContain("GET /api/v1/mcp/manifest");
    expect(emitters).not.toContain("mcp_client_permission");
    expect(emitters).not.toContain('Slug: "mcp", Role: "agent_tools"');
  });
});
