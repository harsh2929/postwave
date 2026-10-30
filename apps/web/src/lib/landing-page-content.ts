// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure model + rendering helpers for the landing-page editor (LAND-005),
// draft preview (LAND-008), SEO authoring/metadata (LAND-007) and the public
// URL (LAND-016/021/033). Dependency-free and JSX-free so every transform is
// unit-tested synchronously.
//
// PATCH-replace footgun (LAND rule #4): the backend treats a non-nil `blocks`
// field as a FULL REPLACE. `serializeContent` therefore always emits the
// COMPLETE block list (hero + all features + the preserved signup_form) so a
// save can never silently drop blocks.

// ---------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------

export interface HeroContent {
  heading: string;
  body: string;
}

export interface FeatureContent {
  /** Stable client id for React keys + reorder; never persisted. */
  id: string;
  heading: string;
  body: string;
}

export interface LandingContent {
  hero: HeroContent;
  features: FeatureContent[];
}

type Block = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

let featureSeq = 0;
/** Monotonic client id for a new feature row (module-local, never persisted). */
export function newFeatureId(): string {
  featureSeq += 1;
  return `feat-${featureSeq}`;
}

export function newFeature(): FeatureContent {
  return { id: newFeatureId(), heading: "", body: "" };
}

/**
 * Parse persisted `blocks` into the editor's normalized shape. The hero block
 * (type === "hero") supplies heading/body; every non-hero, non-signup block
 * becomes an editable feature (tolerant of heading/title and body/content
 * aliases the public renderer already reads).
 */
export function parseContent(blocks: readonly Block[] | null | undefined): LandingContent {
  const list = Array.isArray(blocks) ? blocks : [];
  const heroBlock = list.find((b) => str(b.type) === "hero");
  const hero: HeroContent = {
    heading: str(heroBlock?.heading),
    body: str(heroBlock?.body),
  };
  const features: FeatureContent[] = list
    .filter((b) => {
      const t = str(b.type);
      return t !== "hero" && t !== "signup_form";
    })
    .map((b) => ({
      id: newFeatureId(),
      heading: str(b.heading) || str(b.title),
      body: str(b.body) || str(b.content),
    }));
  return { hero, features };
}

/**
 * Serialize the editor model back to a COMPLETE block list for PATCH. The
 * original blocks are passed so the signup_form block (button label etc.) is
 * preserved rather than dropped — the public page always renders a subscribe
 * form, and losing its config would be a silent regression.
 */
export function serializeContent(
  content: LandingContent,
  originalBlocks?: readonly Block[] | null,
): Block[] {
  const signup =
    (originalBlocks ?? []).find((b) => str(b.type) === "signup_form") ?? {
      type: "signup_form",
      button: "Subscribe",
    };
  const out: Block[] = [
    { type: "hero", heading: content.hero.heading, body: content.hero.body },
  ];
  for (const f of content.features) {
    out.push({ type: "feature", heading: f.heading, body: f.body });
  }
  out.push(signup);
  return out;
}

/** Move an array item from one index to another. Pure; returns a new array. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

export interface SeoFields {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
}

export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 200;

export function parseSeo(seo: Record<string, unknown> | null | undefined): SeoFields {
  const s = seo ?? {};
  return {
    title: str(s.title),
    description: str(s.description),
    // Accept both snake and camel for the URL-ish fields.
    canonical: str(s.canonical) || str(s.canonical_url),
    ogImage: str(s.og_image) || str(s.ogImage) || str(s.image),
  };
}

/**
 * Serialize SEO fields for persistence. Emits a stable, canonical key set and
 * omits empty values so a page without SEO stays a clean `{}` rather than a
 * bag of empty strings.
 */
export function serializeSeo(fields: SeoFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const title = fields.title.trim();
  const description = fields.description.trim();
  const canonical = fields.canonical.trim();
  const ogImage = fields.ogImage.trim();
  if (title) out.title = title;
  if (description) out.description = description;
  if (canonical) out.canonical = canonical;
  if (ogImage) out.og_image = ogImage;
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface SeoErrors {
  title?: string;
  description?: string;
  canonical?: string;
  ogImage?: string;
}

/** Validate SEO fields; returns a per-field error map (empty when valid). */
export function validateSeo(fields: SeoFields): SeoErrors {
  const errors: SeoErrors = {};
  if (fields.title.trim().length > SEO_TITLE_MAX) {
    errors.title = `Keep the title under ${SEO_TITLE_MAX} characters so it isn't truncated in search results.`;
  }
  if (fields.description.trim().length > SEO_DESCRIPTION_MAX) {
    errors.description = `Keep the description under ${SEO_DESCRIPTION_MAX} characters.`;
  }
  if (fields.canonical.trim() && !isHttpUrl(fields.canonical.trim())) {
    errors.canonical = "Canonical must be a full http(s) URL.";
  }
  if (fields.ogImage.trim() && !isHttpUrl(fields.ogImage.trim())) {
    errors.ogImage = "Social image must be a full http(s) URL.";
  }
  return errors;
}

export function hasSeoErrors(errors: SeoErrors): boolean {
  return Object.keys(errors).length > 0;
}

// ---------------------------------------------------------------------------
// Public URL
// ---------------------------------------------------------------------------

/** Locale-agnostic public path for a landing page. */
export function publicLandingPath(slug: string): string {
  return `/landing/${encodeURIComponent(slug)}`;
}

/**
 * Full public URL. When `origin` is empty (SSR / pre-mount, to stay hydration-
 * safe) returns the relative path — still a valid href and deterministic.
 */
export function publicLandingUrl(origin: string | undefined, slug: string): string {
  const path = publicLandingPath(slug);
  if (!origin) return path;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

// ---------------------------------------------------------------------------
// Metadata (public page <head>) — LAND-007
// ---------------------------------------------------------------------------

export interface LandingMetadataInput {
  name: string;
  slug: string;
  blocks: readonly Block[] | null | undefined;
  seo: Record<string, unknown> | null | undefined;
}

export interface LandingMetadata {
  title: string;
  description: string;
  canonical: string;
  ogImage?: string;
}

const DEFAULT_META_DESCRIPTION = "Subscribe for updates.";

/**
 * Compute title/description/canonical/og from `seo{}` with graceful fallbacks
 * to the page name and hero body. Pure so the public route's generateMetadata
 * stays a thin adapter and the fallback rules are unit-tested.
 */
export function buildLandingMetadata(
  input: LandingMetadataInput,
  origin?: string,
): LandingMetadata {
  const seo = parseSeo(input.seo);
  const content = parseContent(input.blocks);
  const title = seo.title.trim() || input.name;
  const description =
    seo.description.trim() ||
    content.hero.body.trim() ||
    DEFAULT_META_DESCRIPTION;
  const canonical =
    seo.canonical.trim() || publicLandingUrl(origin, input.slug);
  const meta: LandingMetadata = { title, description, canonical };
  if (seo.ogImage.trim()) meta.ogImage = seo.ogImage.trim();
  return meta;
}

// ---------------------------------------------------------------------------
// Draft preview (LAND-008) — sandboxed-iframe srcDoc
// ---------------------------------------------------------------------------

/** Escape a string for safe interpolation into HTML text/attribute context. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a self-contained HTML document for the draft preview. ALL page-author
 * content is HTML-escaped, and the result is only ever fed to a
 * `sandbox=""` + `srcDoc` iframe — never `dangerouslySetInnerHTML` into the app
 * origin — so authored copy cannot script the admin (LAND rule #2, XSS).
 */
export function buildPreviewHtml(
  content: LandingContent,
  opts: { template?: string; name?: string } = {},
): string {
  const heading = escapeHtml(content.hero.heading || opts.name || "Untitled page");
  const body = escapeHtml(
    content.hero.body || "Join the list for updates.",
  );
  const template = escapeHtml(opts.template || "signup");
  const features = content.features
    .filter((f) => f.heading.trim() || f.body.trim())
    .slice(0, 3)
    .map(
      (f) => `
      <div class="feature">
        <div class="feature-title">${escapeHtml(f.heading || "Feature")}</div>
        <p class="feature-body">${escapeHtml(f.body)}</p>
      </div>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #ffffff; color: #0a0a0a; }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #fafafa; } .feature { border-color: #262626; } .badge { background: #1f1f1f; color: #d4d4d4; } .body { color: #a3a3a3; } }
  .wrap { max-width: 64rem; margin: 0 auto; padding: 4rem 1.5rem; }
  .badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 10px; border-radius: 999px; background: #f4f4f5; color: #52525b; margin-bottom: 20px; }
  h1 { font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.05; letter-spacing: -0.02em; margin: 0; }
  .body { margin-top: 20px; max-width: 42rem; font-size: 1.05rem; line-height: 1.6; color: #52525b; }
  .cta { margin-top: 28px; display: inline-flex; gap: 8px; }
  .cta input { height: 40px; padding: 0 12px; border: 1px solid #d4d4d8; border-radius: 8px; min-width: 220px; }
  .cta button { height: 40px; padding: 0 16px; border: 0; border-radius: 8px; background: #ea580c; color: #fff; font-weight: 600; }
  .features { margin-top: 56px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .feature { border: 1px solid #e4e4e7; border-radius: 8px; padding: 16px; }
  .feature-title { font-size: 14px; font-weight: 600; }
  .feature-body { margin: 8px 0 0; font-size: 14px; color: #71717a; }
</style>
</head>
<body>
  <main class="wrap">
    <span class="badge">${template}</span>
    <h1>${heading}</h1>
    <p class="body">${body}</p>
    <div class="cta">
      <input type="email" placeholder="you@example.com" disabled />
      <button type="button" disabled>Subscribe</button>
    </div>
    <div class="features">${features}</div>
  </main>
</body>
</html>`;
}
