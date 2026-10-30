/**
 * template-ai — pure logic for the on-brand AI template generator
 * (Templates page "Generate with AI" modal).
 *
 * Canonical backend contract:
 *
 *   POST /api/v1/campaign-template-designs
 *     → durable queued/generating/ready/failed design state
 *
 *   - generate brief required, ≤ 8000 characters (the Go side counts RUNES —
 *     utf8.RuneCountInString — so we count code points, not UTF-16
 *     units, or an emoji-heavy brief would pass here and 400 there);
 *   - adaptation instructions ≤ 4000 characters;
 *   - tone optional, ≤ 500 characters (same rune semantics);
 *   - kind ∈ newsletter | promo | announcement (default newsletter);
 *
 * Saving and campaign creation send only the immutable revision number and
 * output hash. HTML/MJML never round-trips from the review UI.
 *
 * Lives in a .ts module (not the .tsx modal) so the node-environment
 * vitest suite can exercise it without a JSX transform.
 */

/* ---------- kinds ----------------------------------------------------- */

export type TemplateGenKind = "newsletter" | "promo" | "announcement";

export const TEMPLATE_GEN_KINDS: { id: TemplateGenKind; label: string }[] = [
  { id: "newsletter", label: "Newsletter" },
  { id: "promo", label: "Promo" },
  { id: "announcement", label: "Announcement" },
];

/* ---------- input validation ------------------------------------------ */

/** Mirrors templateGenBriefMaxRunes in template_generate.go. */
export const TEMPLATE_GEN_BRIEF_MAX = 8000;
export const TEMPLATE_ADAPT_INSTRUCTIONS_MAX = 4000;
export const TEMPLATE_GEN_TONE_MAX = 500;
export const REVIEWED_TEMPLATE_NAME_MAX_BYTES = 200;
export const REVIEWED_TEMPLATE_SUBJECT_MAX_RUNES = 998;
export const REVIEWED_TEMPLATE_PREVIEW_MAX_RUNES = 500;

export type TemplateFidelity = "vibe" | "layout" | "fresh";

export const TEMPLATE_FIDELITY_OPTIONS: readonly {
  id: TemplateFidelity;
  label: string;
  hint: string;
}[] = [
  {
    id: "vibe",
    label: "Keep the vibe",
    hint: "Borrow the visual mood and hierarchy without copying the design.",
  },
  {
    id: "layout",
    label: "Keep the layout",
    hint: "Follow the broad section order while rewriting the content and styling.",
  },
  {
    id: "fresh",
    label: "Fresh direction",
    hint: "Use the source only as loose inspiration for a new composition.",
  },
];

const FIDELITY_INSTRUCTIONS: Record<TemplateFidelity, string> = {
  vibe: "Fidelity: preserve the source's overall mood and hierarchy, but create an original design.",
  layout:
    "Fidelity: preserve the source's broad section order, but rewrite its content and visual treatment.",
  fresh:
    "Fidelity: use the source only as loose inspiration and create a fresh composition.",
};

export function buildTemplateDirection(input: {
  brief: string;
  audience?: string;
  keySections?: string;
  cta?: string;
  fidelity?: TemplateFidelity;
  refinement?: string;
}): string {
  const sections = [input.brief.trim()];
  if (input.fidelity) sections.push(FIDELITY_INSTRUCTIONS[input.fidelity]);
  if (input.audience?.trim()) {
    sections.push(`Audience: ${input.audience.trim()}`);
  }
  if (input.keySections?.trim()) {
    sections.push(`Key sections: ${input.keySections.trim()}`);
  }
  if (input.cta?.trim()) {
    sections.push(`Primary call to action: ${input.cta.trim()}`);
  }
  if (input.refinement?.trim()) {
    sections.push(`Next-version refinement: ${input.refinement.trim()}`);
  }
  return sections.filter(Boolean).join("\n\n");
}

export interface GeneratedTemplateReviewChecks {
  accessibility: string[];
  mergeTags: string[];
  compliance: string[];
}

/**
 * Lightweight, local review hints only. These deliberately do not replace the
 * campaign editor's authoritative pre-send and compliance checks.
 */
export function reviewGeneratedTemplateDraft(input: {
  body_html: string;
  variables?: Record<string, unknown>;
  unresolved_variables: string[];
}): GeneratedTemplateReviewChecks {
  const html = input.body_html;
  const imageTags = html.match(/<img\b[^>]*>/gi) ?? [];
  const missingAltCount = imageTags.filter(
    (tag) => !/\balt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(tag),
  ).length;
  const accessibility: string[] = [];
  if (missingAltCount > 0) {
    accessibility.push(
      `${missingAltCount.toLocaleString()} image${missingAltCount === 1 ? "" : "s"} may be missing alt text.`,
    );
  }
  if (!/<h[1-6]\b/i.test(html)) {
    accessibility.push(
      "No heading was detected. Add a clear heading structure before sending.",
    );
  }

  const knownVariables = new Set([
    ...Object.keys(input.variables ?? {}),
    ...input.unresolved_variables,
  ]);
  const bodyVariables = new Set<string>();
  for (const match of html.matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g)) {
    const name = match[1]?.trim();
    if (name) bodyVariables.add(name);
  }
  const unregisteredVariables = [...bodyVariables].filter(
    (name) => !knownVariables.has(name),
  );
  const mergeTags: string[] = [];
  if (input.unresolved_variables.length > 0) {
    mergeTags.push(
      `Values are still needed for: ${input.unresolved_variables.join(", ")}.`,
    );
  }
  if (unregisteredVariables.length > 0) {
    mergeTags.push(
      `These merge tags are not registered in the draft: ${unregisteredVariables.join(", ")}.`,
    );
  }

  const compliance: string[] = [];
  if (!/(?:unsubscribe|preference[\s_-]*center|opt[\s_-]*out)/i.test(html)) {
    compliance.push(
      "No unsubscribe or preference link was detected. Add the workspace compliance block before sending.",
    );
  }
  if (!/(?:physical|mailing|company|postal)[\s_-]*address/i.test(html)) {
    compliance.push(
      "No sender postal-address placeholder was detected. Confirm the campaign footer before sending.",
    );
  }

  return { accessibility, mergeTags, compliance };
}

/** Code-point count — matches Go's utf8.RuneCountInString, NOT
 *  String.prototype.length (UTF-16 units). */
export function runeCount(s: string): number {
  let n = 0;
  // for..of iterates by code point (vs .length's UTF-16 units).
  for (const ch of s) {
    void ch;
    n += 1;
  }
  return n;
}

/**
 * Client-side mirror of the server's input gate. Returns a
 * ready-to-render error string, or null when the input would pass.
 */
export function validateTemplateGenInput(input: {
  brief: string;
  tone?: string;
  briefMax?: number;
}): string | null {
  const brief = input.brief.trim();
  if (!brief) {
    return "Describe the email you want — audience, content, and call to action.";
  }
  const briefRunes = runeCount(brief);
  const briefMax = input.briefMax ?? TEMPLATE_GEN_BRIEF_MAX;
  if (briefRunes > briefMax) {
    return `Brief is too long (${briefRunes.toLocaleString()} of ${briefMax.toLocaleString()} characters).`;
  }
  const tone = (input.tone ?? "").trim();
  const toneRunes = runeCount(tone);
  if (toneRunes > TEMPLATE_GEN_TONE_MAX) {
    return `Tone is too long (${toneRunes} of ${TEMPLATE_GEN_TONE_MAX} characters).`;
  }
  return null;
}

/* ---------- honest error copy ----------------------------------------- */

/** Structural subset of ApiErr["error"] — keeps the module decoupled
 *  from the api-client barrel for tests. */
export interface TemplateGenErrorLike {
  message: string;
  status?: number;
  retryAfterSeconds?: number;
  kind?: string;
}

/**
 * Honest, status-specific copy for a failed generate call:
 *
 *   429 → the per-tenant daily AI quota is spent (surface retry-after
 *         when the server sent one) — NOT a transient rate limit;
 *   503 → the voice service runs without an LLM key on this
 *         deployment (NOT an outage — feature unconfigured);
 *   timeout → the 60s single-attempt budget elapsed; nothing was
 *         drafted or charged retroactively;
 *   anything else → verbatim server/network message.
 */
export function describeTemplateGenError(err: TemplateGenErrorLike): string {
  if (err.status === 429) {
    const after =
      err.retryAfterSeconds != null && err.retryAfterSeconds > 0
        ? ` Try again in ~${Math.ceil(err.retryAfterSeconds)}s.`
        : " Try again later.";
    return `AI quota reached: ${err.message}${after}`;
  }
  if (err.status === 503) {
    return `AI template generation isn't configured on this server (${err.message}). You can still build templates by hand via "New template".`;
  }
  if (err.kind === "timeout") {
    return "The generator didn't answer within 60 seconds, so no draft was produced. Try a shorter brief.";
  }
  return `Couldn't generate the template: ${err.message}`;
}

/** Matches the page-level slugify + the server slug regex
 *  /^[a-z][a-z0-9-]{0,79}$/. */
function slugifyName(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Slug for a committed design. The caller uses the durable design ID as a
 * deterministic suffix, so a retry keeps the same exact commit identity.
 * Falls back to "ai-template" when the name
 * slugifies to nothing usable; total length stays within the server's
 * 80-char slug cap and the leading character is always a letter.
 */
export function aiTemplateSlug(name: string, suffix: string): string {
  let base = slugifyName(name);
  if (!base || !/^[a-z]/.test(base)) base = base ? `ai-${base}` : "ai-template";
  const cleanSuffix = slugifyName(suffix);
  const tail = cleanSuffix ? `-${cleanSuffix}` : "";
  return `${base.slice(0, 80 - tail.length)}${tail}`;
}
