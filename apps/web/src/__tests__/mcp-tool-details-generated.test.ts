// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import details from "@/lib/mcp-tool-details.generated.json";
import {
  findSkillBySlug,
  listSkillSlugs,
  skillsByCategory,
} from "@/lib/docs/loadSkills";
import catalog from "@/lib/mcp-tools.json";

describe("generated MCP documentation catalog", () => {
  it("matches the reviewed tool sources", () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/generate-mcp-tool-details.mjs"), "--check"],
      { cwd: path.resolve("."), encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`catalog OK (${catalog.length} tools)`);
  });

  it("retains rich bounded details without runtime TypeScript source reads", () => {
    expect(details).toHaveLength(catalog.length);
    expect(
      details.every(
        (tool) =>
          tool.source.startsWith("tools/") &&
          tool.source.endsWith(".ts") &&
          Array.isArray(tool.inputFields) &&
          tool.fullDescription.length > 0,
      ),
    ).toBe(true);

    const loader = readFileSync(
      path.resolve("src/lib/docs/loadSkills.ts"),
      "utf8",
    );
    expect(loader).toContain("mcp-tool-details.generated.json");
    expect(loader).not.toContain('from "node:fs"');
    expect(loader).not.toContain("packages/mcp-server/src/tools");
  });

  it("publishes the exact-admin SMS suppression tool inputs without generated drift", () => {
    const list = details.find((tool) => tool.name === "sms_suppression_list");
    const add = details.find((tool) => tool.name === "sms_suppression_add");
    const remove = details.find(
      (tool) => tool.name === "sms_suppression_remove",
    );

    expect(list?.description).toContain("Exact-admin");
    expect(list?.description).toContain("JSON body, never a URL");
    expect(list?.inputFields.map((field) => field.name)).toEqual([
      "tenant_id",
      "reason",
      "phone",
      "cursor",
      "limit",
    ]);
    expect(
      list?.inputFields.find((field) => field.name === "tenant_id"),
    ).toMatchObject({ kind: "string", optional: false });
    expect(add?.inputFields.map((field) => field.name)).toEqual(["phone"]);
    expect(remove?.inputFields.map((field) => field.name)).toEqual([
      "suppression_id",
      "tenant_id",
      "confirm_manual_hold_removal",
    ]);
    expect(
      remove?.inputFields.find(
        (field) => field.name === "confirm_manual_hold_removal",
      ),
    ).toMatchObject({ kind: "literal", optional: false, enumValues: ["true"] });
  });

  it("publishes all five exact-admin Route43 tools with privacy and CAS metadata", () => {
    const names = [
      "push_suppression_list",
      "push_suppression_add",
      "push_suppression_remove",
      "push_suppression_bulk_import",
      "push_suppression_bulk_remove",
    ];
    const push = details.filter((tool) => names.includes(tool.name));

    expect(push.map((tool) => tool.name)).toEqual(names);
    expect(new Set(push.map((tool) => tool.category))).toEqual(
      new Set(["push"]),
    );

    const [list, add, remove, bulkImport, bulkRemove] = push;
    expect(list?.description).toContain("Exact-admin");
    expect(list?.description).toContain("16-hex fingerprints");
    expect(list?.description).toContain("automatic provider feedback");
    expect(list?.description).toContain("Web is registry-only");
    expect(list?.fullDescription).toContain("never raw tokens or full digests");
    expect(list?.inputFields.map((field) => field.name)).toEqual([
      "tenant_id",
      "platform",
      "reason",
      "hash_prefix",
      "cursor",
      "limit",
    ]);

    expect(add?.description).toContain("manual/dashboard authority");
    expect(add?.description).toContain("must never enter logs or evidence");
    expect(add?.inputFields.map((field) => field.name)).toEqual([
      "tenant_id",
      "device_token",
      "platform",
      "confirm_manual_hold",
    ]);
    expect(
      add?.inputFields.find((field) => field.name === "device_token"),
    ).toMatchObject({ kind: "string", optional: false });
    expect(
      add?.inputFields.find((field) => field.name === "confirm_manual_hold"),
    ).toMatchObject({ kind: "literal", optional: false, enumValues: ["true"] });

    expect(remove?.description).toContain("compare-and-swap");
    expect(remove?.description).toContain("stillSuppressed=true");
    expect(remove?.inputFields.map((field) => field.name)).toEqual([
      "tenant_id",
      "suppression_id",
      "expected_version",
      "confirm_manual_hold_removal",
    ]);
    expect(
      remove?.inputFields.find((field) => field.name === "expected_version"),
    ).toMatchObject({ kind: "number", optional: false });

    expect(bulkImport?.inputFields.map((field) => field.name)).toEqual([
      "tenant_id",
      "items",
      "confirm_manual_holds",
    ]);
    expect(bulkRemove?.inputFields.map((field) => field.name)).toEqual([
      "tenant_id",
      "items",
      "confirm_manual_hold_removals",
    ]);
    expect(bulkRemove?.description).toContain("stillSuppressed truth");

    const readme = readFileSync(
      path.resolve("../../packages/mcp-server/README.md"),
      "utf8",
    );
    const publicCategoryCount = new Set(
      catalog.map((tool) => tool.category),
    ).size;
    const registry = readFileSync(
      path.resolve("../../packages/mcp-server/src/tools/index.ts"),
      "utf8",
    );
    const allTools = registry.slice(
      registry.indexOf("export function allTools"),
    );
    const sourceFamilyCount = (
      allTools.match(/\.\.\.[a-zA-Z]+Tools\(client\)/g) ?? []
    ).length;
    expect(readme).toContain(`contains ${catalog.length} tool definitions`);
    expect(readme).toContain(
      `${catalog.length} definitions across ${sourceFamilyCount} tool families`,
    );
    // campaignTools and campaignTemplateTools intentionally share the public
    // `campaigns` label: source families and documentation labels are related
    // inventories, not interchangeable counts.
    expect(sourceFamilyCount).toBe(publicCategoryCount + 1);
    expect(publicCategoryCount).toBe(31);
  });

  it("publishes the account-bound Klaviyo migration and cutover contract", () => {
    const credentials = details.find(
      (tool) => tool.name === "migrate_credentials",
    );
    const cutover = details.find(
      (tool) => tool.name === "migrate_cutover_evidence",
    );
    const discover = details.find((tool) => tool.name === "migrate_discover");
    const refresh = details.find(
      (tool) => tool.name === "migrate_source_session_refresh",
    );

    expect(credentials?.description).toContain("Klaviyo");
    expect(credentials?.fullDescription).toContain("private API key");
    expect(credentials?.fullDescription).toContain("account ID");
    expect(credentials?.fullDescription).toContain(
      "only through the direct API/SDK",
    );
    expect(credentials?.fullDescription).toContain(
      "not a Moosewave-managed migration OAuth flow",
    );
    expect(credentials?.fullDescription).toContain(
      "second job for the same tenant/account is rejected",
    );
    expect(
      credentials?.inputFields.find((field) => field.name === "account_id"),
    ).toMatchObject({ kind: "string", optional: true });
    expect(
      refresh?.inputFields.find((field) => field.name === "account_id"),
    ).toMatchObject({ kind: "string", optional: true });
    expect(cutover?.description).toContain("Klaviyo");
    expect(cutover?.fullDescription).toContain(
      "ActiveCampaign, Beehiiv, HubSpot, Klaviyo, or Customer.io",
    );
    expect(discover?.fullDescription).toContain(
      "sent email campaign archive rows",
    );
    expect(discover?.fullDescription).toContain(
      "SMS/push records never materialize as email campaigns",
    );
    expect(discover?.fullDescription).toContain("stable Get Profiles");
    expect(discover?.fullDescription).toContain("secondary email identifiers");
    expect(discover?.fullDescription).toContain(
      "independent per-address consent/suppression state",
    );
    expect(discover?.fullDescription).toContain("10 requests/second");
    expect(discover?.fullDescription).toContain("150 requests/minute");
    expect(discover?.fullDescription).toContain("Klaviyo list <id>");
    expect(discover?.fullDescription).toContain("Klaviyo segment <id>");
    expect(discover?.fullDescription).toContain(
      "send-targetable list/segment projection",
    );
    expect(discover?.fullDescription).toContain(
      "does not expose a separate raw Klaviyo membership count",
    );
    expect(discover?.fullDescription).toContain(
      "Draft campaign-message definitions and flow definitions may be null",
    );
    expect(discover?.fullDescription).toContain("provider IDs only");
    expect(discover?.fullDescription).toContain(
      "Eight static product-area source-archive rows are emitted unconditionally",
    );
    expect(discover?.fullDescription).toContain(
      "not detected source inventory",
    );
  });
});

describe("skill page addressing", () => {
  // Every skill becomes a statically generated page at /docs/skills/<slug>,
  // linked from the sidebar and from the search index. Nothing checked the
  // addressing: the assertion above compares the two catalogs by *length*, and
  // two lists of 275 can still disagree about which 275.
  it("reads both catalogs", () => {
    // Guard the guard: empty inputs would satisfy every comparison below.
    expect(details.length).toBeGreaterThan(100);
    expect(catalog.length).toBeGreaterThan(100);
  });

  it("documents exactly the tools the catalog publishes", () => {
    const documented = new Set(details.map((tool) => tool.name));
    const published = new Set(catalog.map((tool) => tool.name));
    // A repeated name would shrink the set and hide a missing tool behind a
    // matching length.
    expect(documented.size).toBe(details.length);
    expect([...published].filter((n) => !documented.has(n)).sort()).toEqual([]);
    expect([...documented].filter((n) => !published.has(n)).sort()).toEqual([]);
  });

  it("agrees with the catalog about categories, not just tools", () => {
    // /docs/skills reads its headline numbers from two different artifacts:
    // the <title>/description use MCP_CATEGORY_COUNT (derived from
    // mcp-tools.json) while the visible paragraph and the jump-list use
    // skillsByCategory() (derived from the details artifact). Identical tool
    // sets do not imply identical category sets — a recategorised tool would
    // leave the page's own heading disagreeing with its own body.
    const documented = new Set(details.map((tool) => tool.category));
    const published = new Set(catalog.map((tool) => tool.category));
    expect(documented.size).toBeGreaterThan(5); // guard the guard
    expect([...published].filter((c) => !documented.has(c)).sort()).toEqual([]);
    expect([...documented].filter((c) => !published.has(c)).sort()).toEqual([]);
  });

  it("uses categories that survive being put in a URL", () => {
    // The index renders href={`#${category}`} and id={category} with no
    // escaping, so a category needing percent-encoding would make the chip and
    // the section disagree — the shape that broke the API tag anchors.
    const unsafe = [...new Set(details.map((tool) => tool.category))]
      .filter((category) => encodeURIComponent(category) !== category)
      .sort();
    expect(unsafe).toEqual([]);
  });

  it("gives every skill a distinct, URL-safe slug", () => {
    // Two tools sharing a slug means generateStaticParams emits it twice, one
    // page wins, and the other tool is unreachable with nothing failing.
    const bySlug = new Map<string, string[]>();
    for (const tool of details) {
      bySlug.set(tool.slug, [...(bySlug.get(tool.slug) ?? []), tool.name]);
    }
    const collisions = [...bySlug.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([slug, names]) => `${slug}: ${names.join(" | ")}`);
    expect(collisions.sort()).toEqual([]);

    const unsafe = details
      .filter((tool) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool.slug))
      .map((tool) => `${tool.name} → ${tool.slug}`);
    expect(unsafe.slice(0, 10)).toEqual([]);
  });

  it("resolves every generated slug back to its skill", () => {
    const unresolved = listSkillSlugs()
      .filter(({ skill }) => !findSkillBySlug(skill))
      .map(({ skill }) => skill);
    expect(unresolved.slice(0, 10)).toEqual([]);
  });

  it("groups every skill exactly once, repeatably", () => {
    // skillsByCategory memoises the grouping and sorts a copy of each bucket.
    // The copy turns out not to be observable — sorting the cached array in
    // place is idempotent, so a second caller sees the same order either way
    // (checked by mutating the source: the assertions here still passed). What
    // is worth pinning is that the memo is stable and total: every skill lands
    // in exactly one bucket, and the second call agrees with the first. A
    // grouping that dropped or duplicated a skill would silently shrink the
    // sidebar's "Skills by category" tree.
    const first = skillsByCategory();
    const second = skillsByCategory();
    expect(second.map((g) => g.category)).toEqual(first.map((g) => g.category));
    expect(second.map((g) => g.skills.map((s) => s.slug))).toEqual(
      first.map((g) => g.skills.map((s) => s.slug)),
    );
    expect(first.reduce((n, g) => n + g.skills.length, 0)).toBe(details.length);
  });
});
