// SPDX-License-Identifier: AGPL-3.0-only
//
// Shapes only — deliberately import-free.
//
// The docs navigation provider is a client component, and `nav-index.ts`
// statically imports packages/openapi/openapi.json and the generated skill
// catalogue. If the client file imported anything of substance from there, a
// bundler that could not prove those module-level reads side-effect-free would
// pull megabytes of JSON into the browser — the exact cost RSC-01 is about.
// So the boundary between them is types, and types are erased at compile time.

export interface DocsNavApiItem {
  slug: string;
  method: string;
  path: string;
}

export interface DocsNavSkillItem {
  slug: string;
  name: string;
}

export interface SidebarApiTagGroup {
  tag: string;
  /** Item count, carried separately so the summary can report it without items. */
  count?: number;
  /** Absent in the summary; present once the full index has loaded. */
  items?: DocsNavApiItem[];
}

export interface SidebarSkillCategoryGroup {
  category: string;
  count?: number;
  items?: DocsNavSkillItem[];
}

export interface DocsNavData {
  apiGroups: SidebarApiTagGroup[];
  skillGroups: SidebarSkillCategoryGroup[];
  migrationSources: { slug: string; name: string }[];
  integrations: { slug: string; name: string }[];
}
