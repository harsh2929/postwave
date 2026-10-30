/**
 * lib/landingLifecycle.ts — the landing-page status verbs, ported from
 * desktop's `statusAction` (LandingPagesSection.tsx / landing-pages-helpers
 * .ts:177-185) and checked against the server:
 *
 *   published → draft   "Unpublish"        (the public URL 404s immediately)
 *   archived  → draft   "Restore to draft" (never archived→published direct)
 *   draft     → published "Publish"
 *
 * ARCHIVE IS A *SOFT* DELETE HERE, THE OPPOSITE OF FORMS. `Repo.Delete` runs
 * `UPDATE landing_pages SET status='archived'` (landingpages.go:343-352) —
 * nothing is removed, leads survive, and the restore path above exists. So
 * the archive verb confirms as destructive (it stops a public page) but never
 * demands a typed phrase: it is reversible.
 *
 * EVERY write on this resource is ADMIN (POST/PATCH/DELETE all mounted behind
 * ScopeAdmin, analytics_realtime_routes.go:75-77) and ONLINE-ONLY: none is on
 * the offline-queue allowlist, and each one changes what the public internet
 * is served.
 *
 * Import-free; unit-tested in the node vitest run.
 */

export const LANDING_WRITE_MINIMUM_ROLE = "admin" as const;

export interface LandingStatusVerb {
  /** What PATCH /landing-pages/{id} will say: `{status: target}`. */
  target: "draft" | "published";
  label: string;
  confirmTitle: string;
  confirmMessage: string;
  destructive: boolean;
  successMessage: string;
}

/**
 * The one status verb this page offers, or null for a status this build does
 * not recognise (never guess a direction on an unknown state).
 */
export function landingStatusVerb(
  status: string | null | undefined,
  name?: string | null,
): LandingStatusVerb | null {
  const current = (status ?? "").trim().toLowerCase();
  const label = (name ?? "").trim() || "this page";
  if (current === "published") {
    return {
      target: "draft",
      label: "Unpublish",
      confirmTitle: `Unpublish ${label}?`,
      confirmMessage:
        "The public URL stops being served the moment this lands — anyone opening an ad or a campaign link gets Not Found. Leads already captured are kept.",
      destructive: true,
      successMessage: `${label} is a draft — its public URL is no longer served.`,
    };
  }
  if (current === "archived") {
    return {
      target: "draft",
      label: "Restore to draft",
      confirmTitle: `Restore ${label}?`,
      confirmMessage:
        "The page comes out of the archive as an unpublished draft. Publishing it again is a separate step.",
      destructive: false,
      successMessage: `${label} restored as a draft.`,
    };
  }
  if (current === "draft") {
    return {
      target: "published",
      label: "Publish",
      confirmTitle: `Publish ${label}?`,
      confirmMessage:
        "The page goes live at its public URL immediately and starts capturing leads.",
      destructive: false,
      successMessage: `${label} is live.`,
    };
  }
  return null;
}

export interface ArchiveLandingCopy {
  confirmTitle: string;
  confirmMessage: string;
  successMessage: string;
}

/** DELETE = soft archive (see the header); reversible, so no typed phrase. */
export function archiveLandingCopy(name?: string | null): ArchiveLandingCopy {
  const label = (name ?? "").trim() || "this page";
  return {
    confirmTitle: `Archive ${label}?`,
    confirmMessage:
      "The page is retired and stops being served. Leads it captured are kept, and it can be restored to a draft later.",
    successMessage: `${label} archived.`,
  };
}

/* ------------------------------------------------------------------ *
 * Creating a page — name + slug, per desktop's create body
 * ({slug, name}, landing-pages-helpers.ts:164-166). Domain/template exist on
 * the wire but stay desk-side: both only matter to the block editor.
 * ------------------------------------------------------------------ */

export interface CreateLandingDraft {
  name: string;
  slug: string;
}

/** Landing slugs are path segments; hold them to the forms slug alphabet. */
const LANDING_SLUG_PATTERN = /^[a-z0-9._~-]+$/;

export function suggestLandingSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
}

/** Null when submittable; otherwise the sentence to show. */
export function createLandingDraftProblem(
  draft: CreateLandingDraft,
): string | null {
  if (draft.name.trim() === "") return "Give the page a name.";
  const slug = draft.slug.trim();
  if (slug === "") return "The page needs a slug — it becomes the public URL.";
  if (!LANDING_SLUG_PATTERN.test(slug))
    return "The slug may only use lowercase letters, digits, and . _ ~ -";
  return null;
}
