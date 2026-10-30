/**
 * landing-pages-helpers — pure logic behind the Landing pages section
 * on the Forms page (apps/api/internal/landingpages). JSX-free for the
 * node vitest suite.
 *
 * Wire notes (ROADMAP-WRAPPERS T2): CRUD at /api/v1/landing-pages,
 * list returns a BARE ARRAY, mutations are admin-scoped. Status is
 * draft|published|archived. blocks/seo/tracking/metrics are free-form
 * jsonb (the server normalises nulls to []/{}). The PUBLIC RENDER
 * lives in apps/web at /landing/[slug] — it is NOT served by the
 * desktop API host, so URLs built here are paths on the tenant's web
 * deployment (or the page's custom domain), never getApiUrl().
 */

import type {
  LandingPage,
  LandingPageCreateInput,
  LandingPagePatch,
} from "../../lib/api-client";

/* ---------- slug + URL -------------------------------------------------- */

export function slugifyPageName(s: string): string {
  const normalized = s
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return "";
  const withLeadingLetter = /^[a-z]/.test(normalized)
    ? normalized
    : `page-${normalized}`;
  return withLeadingLetter.slice(0, 64).replace(/-+$/g, "");
}

export const LANDING_SLUG_RE = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Where the page is served. With a custom domain we can render a full
 * https URL; without one we only know the path on the tenant's web
 * app — the desktop client doesn't know that host, so we return the
 * path and let the UI say so honestly.
 */
export function landingPageUrl(page: Pick<LandingPage, "slug" | "domain">): {
  url: string;
  absolute: boolean;
} {
  const path = `/landing/${encodeURIComponent(page.slug)}`;
  const domain = (page.domain ?? "").trim();
  if (domain) {
    return {
      url: `https://${domain.replace(/\/+$/, "")}${path}`,
      absolute: true,
    };
  }
  return { url: path, absolute: false };
}

/* ---------- display ------------------------------------------------------ */

/** Badge class suffix for a landing-page status (mirrors form badges). */
export function landingStatusTone(
  status: string | undefined,
): "success" | "warning" | "default" {
  const s = (status ?? "draft").toLowerCase();
  if (s === "published") return "success";
  if (s === "archived") return "warning";
  return "default";
}

/** "3 blocks" / "1 block" / "no blocks yet" — counts only; blocks are
 *  free-form jsonb edited elsewhere (apps/web builder). */
export function blocksSummary(
  blocks: ReadonlyArray<unknown> | undefined,
): string {
  const n = Array.isArray(blocks) ? blocks.length : 0;
  if (n === 0) return "no blocks yet";
  return `${n} block${n === 1 ? "" : "s"}`;
}

/** Newest-updated first; ties broken by name for a stable render.
 *  The list endpoint is a bare array, but a minimal/empty response can
 *  arrive as a non-array (null/`{}`) — treat anything non-array as no
 *  pages instead of throwing "pages is not iterable". */
export function sortLandingPages(
  pages: ReadonlyArray<LandingPage> | undefined | null,
): LandingPage[] {
  if (!Array.isArray(pages)) return [];
  return [...pages].sort((a, b) => {
    const at = Date.parse(a.updated_at ?? "") || 0;
    const bt = Date.parse(b.updated_at ?? "") || 0;
    return bt - at || (a.name ?? "").localeCompare(b.name ?? "");
  });
}

/* ---------- editor ------------------------------------------------------- */

export interface LandingPageDraft {
  /** null → creating; the page id → editing that row. */
  id: string | null;
  name: string;
  slug: string;
  slugTouched: boolean;
  domain: string;
  template: string;
}

export function newLandingPageDraft(): LandingPageDraft {
  return {
    id: null,
    name: "",
    slug: "",
    slugTouched: false,
    domain: "",
    template: "",
  };
}

export function landingPageToDraft(p: LandingPage): LandingPageDraft {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    slugTouched: true,
    domain: p.domain ?? "",
    template: p.template ?? "",
  };
}

export type LandingPageBuildResult =
  | { ok: true; create: LandingPageCreateInput; patch: LandingPagePatch }
  | { ok: false; field: "name" | "slug" | "domain"; error: string };

/**
 * Validate + assemble the wire bodies from a draft. The slug is only
 * part of the create body — the PATCH shape doesn't carry it (slugs
 * are immutable server-side), so edits send name/domain/template only.
 */
export function buildLandingPageInput(
  d: LandingPageDraft,
): LandingPageBuildResult {
  const name = d.name.trim();
  if (!name) return { ok: false, field: "name", error: "Name is required." };
  const slug = d.slug.trim() || slugifyPageName(name);
  if (!slug) return { ok: false, field: "slug", error: "Slug is required." };
  if (!LANDING_SLUG_RE.test(slug)) {
    return {
      ok: false,
      field: "slug",
      error:
        "Slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.",
    };
  }
  const domain = d.domain.trim();
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return {
      ok: false,
      field: "domain",
      error: "Domain should be a bare hostname (e.g. pages.example.com).",
    };
  }
  const template = d.template.trim();
  const create: LandingPageCreateInput = { slug, name };
  if (domain) create.domain = domain;
  if (template) create.template = template;
  const patch: LandingPagePatch = { name };
  // Send empty strings on patch so clearing the fields sticks.
  patch.domain = domain;
  patch.template = template;
  return { ok: true, create, patch };
}

/** The status mutation each row offers. Published pages can be
 *  unpublished back to draft; drafts can be published; archived pages
 *  must be restored to draft before publishing again. */
export function statusAction(status: string | undefined): {
  next: "published" | "draft";
  label: string;
} {
  const s = (status ?? "draft").toLowerCase();
  if (s === "published") return { next: "draft", label: "Unpublish" };
  if (s === "archived") return { next: "draft", label: "Restore to draft" };
  return { next: "published", label: "Publish" };
}
