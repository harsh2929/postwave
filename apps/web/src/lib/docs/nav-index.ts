// SPDX-License-Identifier: AGPL-3.0-only
//
// Two shapes of the docs navigation tree, and the reason there are two.
//
// The sidebar has to be able to reach every endpoint and every skill, but the
// full tree is ~200 KB of JSON: 1,955 operations across 174 tags plus the
// generated skill catalogue. `DocsNavProvider` is a client component, so
// whatever the layout hands it is serialized into the flight payload of every
// document under /docs — ~2,260 URLs — even though every group in that tree
// renders collapsed and the reader never sees the contents of more than one.
//
// So the layout serializes the SUMMARY (group names and counts, plus the two
// short static catalogues, ~7 KB), and the sidebar pulls the full INDEX from
// /api/docs/nav the first time item-level data is actually needed: expanding a
// group, typing in the filter, or landing on an endpoint/skill page whose
// group should open. That request is cacheable and shared across every docs
// page; the inlined copy was neither.
//
// Both shapes are derived from the same source functions, so a group can never
// appear in one and not the other.

import { DOCS_INTEGRATIONS, DOCS_MIGRATION_SOURCES } from "./catalog";
import { operationsByTag } from "./loadOpenAPI";
import { skillsByCategory } from "./loadSkills";
import type { DocsNavData } from "./nav-types";

export type {
  DocsNavApiItem,
  DocsNavData,
  DocsNavSkillItem,
  SidebarApiTagGroup,
  SidebarSkillCategoryGroup,
} from "./nav-types";

let cachedIndex: DocsNavData | null = null;
let cachedSummary: DocsNavData | null = null;

/** Every group with every item. Served from /api/docs/nav, never inlined. */
export function docsNavIndex(): DocsNavData {
  if (cachedIndex) return cachedIndex;
  cachedIndex = {
    apiGroups: operationsByTag().map((g) => ({
      tag: g.tag,
      count: g.operations.length,
      items: g.operations.map((op) => ({
        slug: op.slug,
        method: op.method,
        path: op.path,
      })),
    })),
    skillGroups: skillsByCategory().map((g) => ({
      category: g.category,
      count: g.skills.length,
      items: g.skills.map((s) => ({ slug: s.slug, name: s.name })),
    })),
    migrationSources: [...DOCS_MIGRATION_SOURCES],
    integrations: [...DOCS_INTEGRATIONS],
  };
  return cachedIndex;
}

/**
 * Group names and counts only. This is what crosses the client boundary in the
 * docs layout; it renders the collapsed sidebar exactly as the full tree does.
 */
export function docsNavSummary(): DocsNavData {
  if (cachedSummary) return cachedSummary;
  const full = docsNavIndex();
  cachedSummary = {
    apiGroups: full.apiGroups.map((g) => ({ tag: g.tag, count: g.count })),
    skillGroups: full.skillGroups.map((g) => ({
      category: g.category,
      count: g.count,
    })),
    migrationSources: full.migrationSources,
    integrations: full.integrations,
  };
  return cachedSummary;
}
