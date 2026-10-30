/**
 * lib/campaignTemplateSlug.ts — turning a campaign into a reusable template.
 *
 * Mobile had no path to POST /api/v1/campaigns/{id}/save-as-template at all,
 * so the moment a send beats benchmark — the moment you are actually looking
 * at the numbers, on a phone — was the one moment you could not capture it.
 *
 * The slug is the whole reason this needs pure logic. The gateway enforces
 * `^[a-z][a-z0-9-]{0,79}$` (campaigntemplates.go:266) and answers a violation
 * with 400 `invalid_slug` or 409 `slug_conflict`. A sheet that lets the user
 * type a name, derives a slug from it, and only learns it was invalid from the
 * server has wasted a round trip and a keyboard dismissal to say something it
 * could have known locally.
 *
 * Import-free so the derivation and the validation are testable in the node
 * environment — and so they can be asserted against the Go regex directly.
 */

/** Mirrors campaigntemplates.slugRE exactly. */
const SLUG_RE = /^[a-z][a-z0-9-]{0,79}$/;
export const TEMPLATE_SLUG_MAX = 80;

export function isValidTemplateSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * A slug the gateway will accept, derived from a human name.
 *
 * Returns "" when nothing usable survives (a name of only punctuation, or one
 * starting with a digit and containing no letters) — the caller must treat
 * that as "you have to type a slug", not silently send an empty one, which the
 * gateway rejects with `missing_slug`.
 */
export function slugifyTemplateName(name: string): string {
  const lowered = name
    .normalize("NFKD")
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const dashed = lowered
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  // The pattern requires the FIRST character to be a letter, so a name like
  // "2026 Recap" cannot simply be truncated — drop leading non-letters.
  const fromLetter = dashed.replace(/^[^a-z]+/, "");
  if (!fromLetter) return "";
  return fromLetter.slice(0, TEMPLATE_SLUG_MAX).replace(/-+$/, "");
}

/**
 * Why the typed slug will be rejected, before it is sent. Null when it is fine.
 */
export function templateSlugProblem(slug: string): string | null {
  const trimmed = slug.trim();
  if (!trimmed) return "A slug is required — it's how the template is linked.";
  if (trimmed.length > TEMPLATE_SLUG_MAX) {
    return `Slugs are at most ${TEMPLATE_SLUG_MAX} characters.`;
  }
  if (!/^[a-z]/.test(trimmed))
    return "A slug must start with a lowercase letter.";
  if (!isValidTemplateSlug(trimmed)) {
    return "A slug can only contain lowercase letters, numbers and dashes.";
  }
  return null;
}

/**
 * Failure copy for the save. `slug_conflict` is the one an operator will
 * actually hit — templates accumulate — and it is the one where saying what to
 * do next matters.
 */
export function saveAsTemplateProblem(
  status: number,
  code: string | undefined,
  message: string,
): string {
  if (code === "slug_conflict" || status === 409) {
    return "A template with that slug already exists. Pick a different one.";
  }
  if (code === "invalid_slug") {
    return "That slug isn't valid — lowercase letters, numbers and dashes, starting with a letter.";
  }
  if (code === "missing_slug") {
    return "A slug is required — it's how the template is linked.";
  }
  if (code === "campaign_not_found" || status === 404) {
    return "This campaign no longer exists.";
  }
  if (status === 403) {
    return "Saving as a template is admin-only in this workspace.";
  }
  const trimmed = message.trim();
  return trimmed
    ? `Couldn't save the template: ${trimmed}`
    : "Couldn't save the template.";
}
