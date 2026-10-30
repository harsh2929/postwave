// SPDX-License-Identifier: AGPL-3.0-only
//
// Two things about dashboard query keys, both of which surprised me.
//
// 1. Un-scoped keys are NOT a cross-tenant leak here. 34 distinct keys in the
//    dashboard carry tenant data without a tenant component — ["dashboard",
//    "health"], ["custom-fields"], ["report-definitions"] and so on — and a
//    prior audit flagged exactly this class as a P0. It is covered, but not by
//    key shape: QueryProvider rebuilds the entire QueryClient from a useMemo
//    keyed on the server-resolved identity, and clears the previous client on
//    unmount, so an un-scoped entry cannot outlive the tenant that filled it.
//    That mechanism is what this file protects, because it is the thing every
//    un-scoped key depends on.
//
// 2. flowKeys exported detail/versions/runs factories that nothing ever
//    called, under a comment claiming they had replaced the editor's
//    un-scoped keys. They had not — flow-editor.tsx has no tenant/role in
//    scope to build one from. Dead factories documenting a finished migration
//    are worse than no factories, so they are gone and the comment now says
//    what is true.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { flowKeys } from "@/lib/query-keys";

const SRC = resolve(process.cwd(), "src");

const PROVIDER = readFileSync(
  join(SRC, "components/query-provider.tsx"),
  "utf8",
);

describe("query cache is bounded by identity", () => {
  it("rebuilds the client when the resolved identity changes", () => {
    // A useMemo over initialMe is what makes a workspace switch a render
    // boundary. Without it every un-scoped key in the dashboard becomes a
    // cross-tenant read.
    const memo = /const queryClient = useMemo\(\(\) => \{[\s\S]*?\}, \[([^\]]*)\]\)/.exec(
      PROVIDER,
    );
    expect(memo, "queryClient useMemo not found").not.toBeNull();
    expect(memo![1]).toContain("initialMe");
  });

  it("clears the outgoing client before another identity can mount", () => {
    // invalidateQueries would keep serving the old answer while refetching;
    // clear() is the only correct verb at an identity boundary.
    const effect = /useEffect\(\(\) => \{[\s\S]*?queryClient\.clear\(\)[\s\S]*?\}, \[([^\]]*)\]\)/.exec(
      PROVIDER,
    );
    expect(effect, "identity-teardown effect not found").not.toBeNull();
    expect(effect![1]).toContain("initialMe.tenant_id");
    expect(effect![1]).toContain("initialMe.user_id");
    expect(PROVIDER).toContain("idbPersister.removeClient()");
  });

  it("drops the cache when the context epoch moves", () => {
    // Covers the case identity rebuild cannot: same user, same tenant, fewer
    // permissions (a demotion, a plan downgrade, a view-as preview ending).
    expect(PROVIDER).toContain("subscribeContextEpochCacheReset");
  });
});

describe("flowKeys", () => {
  it("exports only factories that are used", () => {
    // detail/versions/runs sat unused while the editor kept its own keys.
    const used = readFileSync(
      join(SRC, "app/(dashboard)/app/flows/page.tsx"),
      "utf8",
    );
    for (const name of Object.keys(flowKeys)) {
      expect(used, `flowKeys.${name} is exported but never called`).toContain(
        `flowKeys.${name}`,
      );
    }
  });

  it("scopes the list by tenant and role", () => {
    const key = flowKeys.list("tenant-a", "admin");
    expect(key).toContain("tenant-a");
    expect(flowKeys.list("tenant-b", "admin")).not.toEqual(key);
    expect(flowKeys.list("tenant-a", "viewer")).not.toEqual(key);
  });

  it("keeps the editor's invalidation reaching the scoped list", () => {
    // flow-editor invalidates ["flows"], the list caches under
    // ["flows", tenantId, role]. That still works — TanStack matches by
    // prefix — and this pins the prefix relationship the editor relies on,
    // since it is load-bearing and invisible at both call sites.
    const editor = readFileSync(
      join(SRC, "app/(dashboard)/app/flows/_components/flow-editor.tsx"),
      "utf8",
    );
    const invalidated = /invalidateQueries\(\{ queryKey: \["([^"]+)"\] \}\)/.exec(
      editor,
    );
    expect(invalidated, "editor no longer invalidates a literal flows key")
      .not.toBeNull();
    expect(flowKeys.list("t", "admin")[0]).toBe(invalidated![1]);
    // …and it must not be an exact-match invalidation, which would miss.
    expect(editor).not.toMatch(/queryKey: \["flows"\], exact: true/);
  });
});
