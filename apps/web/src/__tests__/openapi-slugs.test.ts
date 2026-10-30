// SPDX-License-Identifier: AGPL-3.0-only
//
// Slugs are the entire addressing scheme for the API reference: 1903 operations
// become 1903 statically generated pages at /docs/api/<slug>, the sidebar links
// by slug, the search index links by slug, and findOperationBySlug resolves
// them back. Nothing checked that the mapping is one-to-one.
//
// It matters because slugify is lossy on purpose — it lowercases uppercase runs
// (getMCPTools and getMcpTools both land on get-mcptools) and replaces every
// non-alphanumeric run with a dash. Two operationIds colliding would give two
// operations the same URL: generateStaticParams emits the slug twice, one page
// wins, and the other endpoint is simply unreachable in the docs with nothing
// failing anywhere.
//
// The collision-disambiguation branch in listOperations is currently dormant —
// no slug carries a "-2" suffix — so it is not a live safety net.
import { describe, expect, it } from "vitest";

import {
  defaultServerUrl,
  findOperationBySlug,
  listOperationSlugs,
  listOperations,
} from "@/lib/docs/loadOpenAPI";

describe("API reference slugs", () => {
  const ops = listOperations();

  it("loads the spec", () => {
    // Guard the guard: an empty spec would satisfy every uniqueness check.
    expect(ops.length).toBeGreaterThan(500);
    expect(listOperationSlugs().length).toBe(ops.length);
  });

  it("gives every operation a distinct slug", () => {
    const byslug = new Map<string, string[]>();
    for (const op of ops) {
      const where = `${op.method.toUpperCase()} ${op.path}`;
      byslug.set(op.slug, [...(byslug.get(op.slug) ?? []), where]);
    }
    const collisions = [...byslug.entries()]
      .filter(([, uses]) => uses.length > 1)
      .map(([slug, uses]) => `${slug}: ${uses.join(" | ")}`);
    expect(collisions.sort()).toEqual([]);
  });

  it("emits slugs that survive a URL round-trip", () => {
    // A slug needing percent-encoding would make the rendered href and the
    // generateStaticParams value disagree, and the page 404 in production
    // while working in dev.
    const unsafe = ops
      .filter((op) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(op.slug))
      .map((op) => `${op.slug} (${op.method} ${op.path})`);
    expect(unsafe.slice(0, 10)).toEqual([]);
  });

  it("resolves every generated slug back to its operation", () => {
    // The round trip the [endpoint] page depends on: anything that does not
    // resolve calls notFound() on a page we ourselves asked Next to build.
    const unresolved = listOperationSlugs()
      .filter(({ endpoint }) => !findOperationBySlug(endpoint))
      .map(({ endpoint }) => endpoint);
    expect(unresolved.slice(0, 10)).toEqual([]);
  });

  it("builds curl against an absolute server URL", () => {
    // Every "Try it" example is `${defaultServerUrl()}${op.path}`. A relative
    // or empty servers[0] would produce a command that cannot run.
    expect(defaultServerUrl()).toMatch(/^https:\/\/[^/\s]+/);
  });
});
