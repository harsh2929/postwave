/**
 * lib/voiceTemplates.ts — the shared prompt/template library, read honestly.
 *
 * THE WIRE SHAPE IS A BARE ARRAY. `GET /api/v1/voice/templates` proxies to the
 * voice service's listTemplates, which answers `writeJSON(w, 200, rows)` where
 * rows is `[]templates.Template` (services/voice/internal/handlers/sequences.go
 * listTemplates). It is NOT an `{items}` envelope. Desktop's client hedges over
 * `{templates|items|data}` (apps/desktop/src/lib/api-client.ts:4873) without
 * handling the array the server actually sends, so this parser accepts BOTH and
 * is the only place that decision lives.
 *
 * DESKTOP'S FIELD NAMES ARE A GUESS. Its VoiceTemplate declares
 * `label`/`body`/`kind` (api-client.ts:4863) and reads `template.prompt` through
 * an index signature. The server emits none of those: a Template is
 * `{id, slug, category, name, description, length, variables[], emails[], tags[]}`
 * (services/voice/internal/templates/types.go). Mobile reads the SERVER's names,
 * so a template renders its real content instead of desktop's
 * "Template content unavailable" placeholder.
 *
 * A template is a SEQUENCE SKELETON, not a one-line prompt: subject/body carry
 * {{variable}} placeholders the generation engine fills from the voice profile.
 * "Apply to prompt" therefore assembles the whole skeleton into text a person
 * can paste into a chat, and says which variables it still expects — collapsing
 * it to a single line would silently drop the emails that ARE the template.
 *
 * No react-native / expo import: vitest runs this in node.
 */

export interface VoiceTemplateVariableWire {
  key?: string;
  label?: string;
  description?: string;
  type?: string;
  required?: boolean;
  example?: string;
}

export interface VoiceTemplateEmailWire {
  position?: number;
  delay_seconds?: number;
  subject_skeleton?: string;
  body_skeleton?: string;
  notes?: string;
}

export interface VoiceTemplateWire {
  id?: string;
  slug?: string;
  category?: string;
  name?: string;
  description?: string;
  length?: number;
  variables?: VoiceTemplateVariableWire[];
  emails?: VoiceTemplateEmailWire[];
  tags?: string[];
  author?: string;
}

/**
 * templates.AllCategories(), in the server's display order, with the labels a
 * phone shows. A category the server adds later falls through to a
 * title-cased slug rather than disappearing from the filter.
 */
export const VOICE_TEMPLATE_CATEGORIES: { value: string; label: string }[] = [
  { value: "welcome", label: "Welcome" },
  { value: "course_launch", label: "Course launch" },
  { value: "product_launch", label: "Product launch" },
  { value: "re_engagement", label: "Re-engagement" },
  { value: "newsletter_series", label: "Newsletter series" },
  { value: "saas_onboarding", label: "SaaS onboarding" },
  { value: "partnership", label: "Partnership" },
  { value: "year_in_review", label: "Year in review" },
  { value: "crisis", label: "Crisis" },
  { value: "cold_warm", label: "Cold / warm" },
  { value: "sales", label: "Sales" },
  { value: "community", label: "Community" },
  { value: "misc", label: "Misc" },
];

export function voiceTemplateCategoryLabel(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "Uncategorised";
  const known = VOICE_TEMPLATE_CATEGORIES.find((c) => c.value === raw);
  if (known) return known.label;
  const words = raw.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return "Uncategorised";
  const [first, ...rest] = words;
  const head = (first ?? "").charAt(0).toUpperCase() + (first ?? "").slice(1);
  return [head, ...rest].join(" ");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Accept the server's bare array first, then the three envelope keys desktop
 * hedges over. Anything else is an empty list — never a thrown parse.
 */
export function parseVoiceTemplates(payload: unknown): VoiceTemplateWire[] {
  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else {
    const rec = asRecord(payload);
    if (rec) {
      for (const key of ["templates", "items", "data"]) {
        if (Array.isArray(rec[key])) {
          rows = rec[key] as unknown[];
          break;
        }
      }
    }
  }
  const out: VoiceTemplateWire[] = [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    // A row with no id cannot be opened, deleted or keyed in a list, so it is
    // dropped rather than rendered as a dead tile.
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) continue;
    out.push(rec as VoiceTemplateWire);
  }
  return out;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Display name; falls back to the slug, then the id, so a tile is never blank. */
export function voiceTemplateTitle(t: VoiceTemplateWire): string {
  return text(t.name) || text(t.slug) || text(t.id) || "Untitled template";
}

/** "Welcome · 5 emails" — the count comes from the emails actually shipped. */
export function voiceTemplateSummary(t: VoiceTemplateWire): string {
  const emails = asArray(t.emails).length;
  const declared = typeof t.length === "number" ? t.length : 0;
  // `length` is the template's declared size; emails[] is what it carries.
  // When they disagree, the carried array is the one a reader can act on.
  const count = emails > 0 ? emails : declared;
  const parts = [voiceTemplateCategoryLabel(t.category)];
  if (count > 0) parts.push(count === 1 ? "1 email" : `${count} emails`);
  return parts.join(" · ");
}

export interface VoiceTemplateVariableLine {
  key: string;
  label: string;
  required: boolean;
  example: string;
}

export function voiceTemplateVariableLines(
  t: VoiceTemplateWire,
): VoiceTemplateVariableLine[] {
  const out: VoiceTemplateVariableLine[] = [];
  for (const raw of asArray(t.variables)) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const key = text(rec.key);
    if (!key) continue;
    out.push({
      key,
      label: text(rec.label) || key,
      required: rec.required === true,
      example: text(rec.example),
    });
  }
  return out;
}

export interface VoiceTemplateEmailLine {
  position: number;
  subject: string;
  body: string;
  notes: string;
}

export function voiceTemplateEmailLines(
  t: VoiceTemplateWire,
): VoiceTemplateEmailLine[] {
  const out: VoiceTemplateEmailLine[] = [];
  asArray(t.emails).forEach((raw, index) => {
    const rec = asRecord(raw);
    if (!rec) return;
    const position =
      typeof rec.position === "number" && Number.isFinite(rec.position)
        ? rec.position
        : index + 1;
    out.push({
      position,
      subject: text(rec.subject_skeleton),
      body: text(rec.body_skeleton),
      notes: text(rec.notes),
    });
  });
  return out.sort((a, b) => a.position - b.position);
}

/**
 * The text "apply to prompt" hands over. The whole skeleton, in order, plus
 * the variables the template still expects — because a template whose
 * {{placeholders}} are unexplained is not a usable prompt.
 */
export function voiceTemplatePromptText(t: VoiceTemplateWire): string {
  const lines: string[] = [voiceTemplateTitle(t)];
  const description = text(t.description);
  if (description) lines.push(description);

  const emails = voiceTemplateEmailLines(t);
  for (const email of emails) {
    const block: string[] = [`Email ${email.position}`];
    if (email.subject) block.push(`Subject: ${email.subject}`);
    if (email.body) block.push(email.body);
    if (email.notes) block.push(`Note: ${email.notes}`);
    // A slot with nothing but a position number teaches the reader nothing.
    if (block.length > 1) lines.push(block.join("\n"));
  }

  const vars = voiceTemplateVariableLines(t);
  if (vars.length > 0) {
    const rendered = vars
      .map((v) => `{{${v.key}}} — ${v.label}${v.required ? " (required)" : ""}`)
      .join("\n");
    lines.push(`Fill in:\n${rendered}`);
  }
  return lines.join("\n\n");
}

/** True when there is genuinely something to paste. */
export function voiceTemplateHasPrompt(t: VoiceTemplateWire): boolean {
  return voiceTemplateEmailLines(t).some((e) => Boolean(e.subject || e.body));
}

/** Filter by category client-side; "" means every category. */
export function filterVoiceTemplates(
  rows: VoiceTemplateWire[],
  category: string,
): VoiceTemplateWire[] {
  const safe = Array.isArray(rows) ? rows : [];
  const want = typeof category === "string" ? category.trim() : "";
  if (!want) return safe;
  return safe.filter((t) => text(t.category) === want);
}

/* ------------------------------------------------------------------ *
 * Generate-from-brief — POST /api/v1/voice/templates/generate (editor)
 * ------------------------------------------------------------------ */

/** generation.ValidTemplateGenKind, verbatim. */
export const TEMPLATE_GEN_KINDS = [
  "newsletter",
  "promo",
  "announcement",
] as const;
export type TemplateGenKind = (typeof TEMPLATE_GEN_KINDS)[number];

/** templateGenBriefMaxRunes / templateGenToneMaxRunes (template_generate.go). */
export const TEMPLATE_GEN_BRIEF_MAX = 8000;
export const TEMPLATE_GEN_TONE_MAX = 200;

export interface TemplateGenerateBody {
  brief: string;
  kind: TemplateGenKind;
  tone?: string;
}

export type TemplateGenerateBuild =
  | { ok: true; body: TemplateGenerateBody; error: null }
  | { ok: false; body: null; error: string };

/**
 * Client mirror of the handler's validation, so a rejected brief says which
 * field is wrong without spending a quota unit. The server stays the
 * authority — its 400 text is rendered verbatim when it disagrees.
 *
 * Note the handler lower-cases and REQUIRES a valid kind (an empty kind fails
 * ValidTemplateGenKind), so the sheet always sends one.
 */
export function buildTemplateGenerateBody(
  brief: string,
  kind: string,
  tone: string,
): TemplateGenerateBuild {
  const trimmedBrief = typeof brief === "string" ? brief.trim() : "";
  if (!trimmedBrief) {
    return { ok: false, body: null, error: "Describe what to write first." };
  }
  if ([...trimmedBrief].length > TEMPLATE_GEN_BRIEF_MAX) {
    return {
      ok: false,
      body: null,
      error: `Brief is too long (max ${TEMPLATE_GEN_BRIEF_MAX} characters).`,
    };
  }
  const lowered = (typeof kind === "string" ? kind : "").trim().toLowerCase();
  const validKind = TEMPLATE_GEN_KINDS.find((k) => k === lowered);
  if (!validKind) {
    return {
      ok: false,
      body: null,
      error: 'Pick a kind: newsletter, promo or announcement.',
    };
  }
  const trimmedTone = typeof tone === "string" ? tone.trim() : "";
  if ([...trimmedTone].length > TEMPLATE_GEN_TONE_MAX) {
    return {
      ok: false,
      body: null,
      error: `Tone is too long (max ${TEMPLATE_GEN_TONE_MAX} characters).`,
    };
  }
  const body: TemplateGenerateBody = { brief: trimmedBrief, kind: validKind };
  if (trimmedTone) body.tone = trimmedTone;
  return { ok: true, body, error: null };
}

export interface GeneratedTemplate {
  name: string;
  subject: string;
  bodyHtml: string;
}

/** `{name, subject, body_html, body_mjml?}` — null when nothing usable came back. */
export function parseGeneratedTemplate(
  payload: unknown,
): GeneratedTemplate | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const name = text(rec.name);
  const subject = text(rec.subject);
  const bodyHtml = text(rec.body_html);
  if (!subject && !bodyHtml) return null;
  return { name, subject, bodyHtml };
}

/** Copyable text for a generated draft. */
export function generatedTemplatePromptText(g: GeneratedTemplate): string {
  const parts: string[] = [];
  if (g.name) parts.push(g.name);
  if (g.subject) parts.push(`Subject: ${g.subject}`);
  if (g.bodyHtml) parts.push(g.bodyHtml);
  return parts.join("\n\n");
}

/* ------------------------------------------------------------------ *
 * Failure sentences
 * ------------------------------------------------------------------ */

/** Reads are `read:campaigns`; the proxy 502/503s when voice is unreachable. */
export function voiceTemplatesErrorMessage(
  status: number,
  fallback?: string | undefined,
): string {
  if (status === 403) {
    return "Templates need campaign read access. Ask an admin.";
  }
  if (status === 404 || status === 405 || status === 501) {
    return "This deployment doesn't ship the shared template library.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "The voice service isn't answering. The library is unavailable right now.";
  }
  return fallback?.trim() || "Couldn't load the template library.";
}

/**
 * Write sentences. DELETE and POST /templates are `admin`; generate is
 * `editor` (write:campaigns) and spends one unit of the daily AI budget, so a
 * 429 says exactly that instead of "try again".
 */
export function voiceTemplateWriteErrorMessage(
  status: number,
  fallback?: string | undefined,
): string {
  if (status === 403) return "Only an admin can change shared templates.";
  if (status === 404) return "That template no longer exists.";
  if (status === 429) {
    return "The workspace's daily AI budget is spent. Try again tomorrow.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "The voice service isn't answering. Nothing was changed.";
  }
  return fallback?.trim() || "That didn't go through.";
}
