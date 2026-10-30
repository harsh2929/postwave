// SPDX-License-Identifier: AGPL-3.0-only
//
// /forge and /forge/docs are the pages an agent developer copies from, so two
// claim families here have to be exact.
//
// 1. The category breakdown. /forge printed nineteen per-category tool counts
//    as literals under a heading that already derived the totals from
//    mcp-tools.json — so the headline was right and seven rows under it were
//    not: campaigns said 13 against 44, migration 6 against 23, admin 10
//    against 22, deliverability 7 against 12. The rows now derive.
//
//    Three rows looked wrong and were not: "domains" is custom-domains,
//    "agent" is agent-primitives, and "commerce reads" groups discounts with
//    gift-subscriptions. Their counts were exactly right under that mapping,
//    and a sweep that assumed display name == slug would have "fixed" three
//    correct numbers. That is why the page now carries explicit slugs.
//
// 2. The scope model. The auth sample told agent authors keys are "scoped:
//    read, write, send, admin". No bare read/write/send scope exists — the
//    real ones are read:subscribers, write:campaigns, send:transactional and
//    so on. A developer following that comment issues a key that grants
//    nothing, and /developers documents the correct set on the same site.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import toolsData from "@/lib/mcp-tools.json";
import {
  mcpExampleTools,
  mcpToolsInCategories,
} from "@/lib/mcp-catalog-stats";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const FORGE = readFileSync(join(SRC, "app/forge/page.tsx"), "utf8");
const FORGE_DOCS = readFileSync(join(SRC, "app/forge/docs/page.tsx"), "utf8");

describe("/forge surface breakdown", () => {
  it("derives every category count instead of printing a literal", () => {
    // The literal `count:` form is the regression. Any row carrying one has
    // stopped tracking the catalog.
    expect(FORGE).not.toMatch(/count:\s*\d+/);
    expect(FORGE).toContain("mcpToolsInCategories(c.slugs)");
    const rows = [...FORGE.matchAll(/slugs:\s*\[([^\]]*)\]/g)];
    expect(rows.length).toBeGreaterThan(15); // guard the guard
  });

  it("names only categories the catalog actually has", () => {
    // mcpToolsInCategories throws on an unknown slug rather than counting
    // zero, so this proves the page renders at all — a row quietly showing 0
    // would be the original bug in a quieter form.
    const known = new Set(toolsData.map((t) => t.category));
    for (const m of FORGE.matchAll(/slugs:\s*\[([^\]]*)\]/g)) {
      const slugs = [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!);
      expect(slugs.length).toBeGreaterThan(0);
      for (const slug of slugs) {
        expect(known.has(slug), `unknown category "${slug}"`).toBe(true);
      }
      expect(() => mcpToolsInCategories(slugs)).not.toThrow();
    }
  });

  it("keeps the grouped and renamed rows meaning what they say", () => {
    // These three are the ones a naive slug==label sweep gets wrong.
    expect(mcpToolsInCategories(["custom-domains"])).toBe(
      toolsData.filter((t) => t.category === "custom-domains").length,
    );
    expect(mcpToolsInCategories(["discounts", "gift-subscriptions"])).toBe(
      toolsData.filter(
        (t) => t.category === "discounts" || t.category === "gift-subscriptions",
      ).length,
    );
    expect(FORGE).toContain('cat: "commerce reads"');
    expect(FORGE).toContain('"discounts", "gift-subscriptions"');
  });
});

describe("/forge example tool names", () => {
  it("derives them instead of hand-writing them", () => {
    // 25 of 53 hand-written names were wrong — 18 named no tool at all
    // (campaign_pause, inbox_predict, migrate_mailchimp, approval_request,
    // sandbox_session_start …) and 7 sat in a different category than the card
    // claiming them. Unlike the counts beside them, these are rendered.
    expect(FORGE).not.toMatch(/^\s*ex: "/m);
    expect(FORGE).toContain("mcpExampleTools(c.slugs)");
  });

  it("yields only real, in-category tool names for every row", () => {
    const byName = new Map(toolsData.map((t) => [t.name, t.category]));
    let checked = 0;
    for (const m of FORGE.matchAll(/slugs:\s*\[([^\]]*)\]/g)) {
      const slugs = [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!);
      const examples = mcpExampleTools(slugs);
      expect(examples.length).toBeGreaterThan(0);
      for (const name of examples) {
        checked += 1;
        expect(byName.has(name), `${name} is not a catalog tool`).toBe(true);
        expect(slugs, `${name} is not in ${slugs.join("/")}`).toContain(
          byName.get(name),
        );
      }
    }
    expect(checked).toBeGreaterThan(40); // guard the guard
  });
});

describe("/forge/docs runnable samples", () => {
  const sample = (name: string): string => {
    const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(FORGE_DOCS);
    expect(m, `${name} sample not found`).not.toBeNull();
    return m![1]!;
  };

  it("cites no budget field or call the API does not have", () => {
    // internal/budgets is read + increment only: LoadBudget, LoadUsage,
    // IncrementUsage, Check. No setter, no mounted route, no warn tier — so
    // apiKeys.update({budget}), budgets.remaining() and soft_threshold_pct
    // were all fiction, and writeExceeded is a single hard 429.
    const budgets = sample("BUDGETS_SNIPPET");
    for (const gone of [
      "soft_threshold_pct",
      "pw.budgets.remaining",
      "pw.apiKeys.update",
    ]) {
      expect(budgets, `sample still uses ${gone}`).not.toContain(gone);
    }
    const repo = readFileSync(
      join(REPO, "apps/api/internal/budgets/repo.go"),
      "utf8",
    );
    expect(repo).not.toMatch(/soft_threshold/);

    // The field names it now shows must be the ones whoami returns.
    const selfinfo = readFileSync(
      join(REPO, "apps/api/internal/mcp/selfinfo.go"),
      "utf8",
    );
    const tags = [...selfinfo.matchAll(/json:"([a-z_]+),?[a-z]*"/g)].map(
      (m) => m[1]!,
    );
    for (const field of ["sends_remaining", "cost_cents_per_month"]) {
      expect(tags, `whoami has no ${field}`).toContain(field);
      expect(budgets).toContain(field);
    }
    // …and the null-vs-zero distinction, which is the actual edge case:
    // nil means unlimited, not exhausted.
    expect(selfinfo).toContain("nil means");
    expect(budgets).toMatch(/null means/i);
  });

  it("cites no sandbox session API", () => {
    // Sandbox is a per-send flag. There is no sandbox.start, no ttl_minutes,
    // and no session concept anywhere in the API.
    const sandbox = sample("SANDBOX_SNIPPET");
    expect(sandbox).not.toMatch(/sandbox\.start|ttl_minutes/);
    expect(
      readFileSync(join(REPO, "apps/api/main.go"), "utf8"),
    ).toContain("/api/v1/sandbox/campaigns/{id}/status");
    expect(sandbox).toContain("sandbox.status");
    // The response shape it advertises has to be the handler's.
    const handlers = readFileSync(
      join(REPO, "apps/api/internal/sandbox/handlers.go"),
      "utf8",
    );
    expect(handlers).toContain('json:"scheduled_remaining"');
    expect(sandbox).toContain("scheduled_remaining");
  });
});

describe("/forge/docs auth sample", () => {
  const scopes = [
    ...readFileSync(
      join(REPO, "apps/api/internal/apikeys/apikeys.go"),
      "utf8",
    ).matchAll(/Scope\w+\s+Scope\s*=\s*"([^"]+)"/g),
  ].map((m) => m[1]!);

  it("reads the real scope constants", () => {
    expect(scopes.length).toBeGreaterThan(5); // guard the guard
    expect(scopes).toContain("send:transactional");
  });

  it("names no scope the gateway does not define", () => {
    // Every bare token the sample presents as a scope must be real.
    const block = /const AUTH = `([\s\S]*?)`;/.exec(FORGE_DOCS)?.[1] ?? "";
    expect(block).not.toBe("");
    expect(block).not.toMatch(/scoped: read, write, send, admin/);
    for (const claimed of ["read:subscribers", "send:transactional", "admin"]) {
      expect(scopes, `sample cites ${claimed}`).toContain(claimed);
      expect(block).toContain(claimed);
    }
  });

  it("says the bare scopes do not exist, since the old sample taught them", () => {
    const block = /const AUTH = `([\s\S]*?)`;/.exec(FORGE_DOCS)?.[1] ?? "";
    expect(block).toMatch(/no bare/i);
  });
});
