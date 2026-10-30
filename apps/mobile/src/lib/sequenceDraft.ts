/**
 * lib/sequenceDraft.ts — the policy behind AI whole-sequence drafting on
 * mobile (AUTOMATION#15).
 *
 * WHAT THE ENDPOINT ACTUALLY IS, read off the handler rather than a doc.
 * `POST /api/v1/voice/sequences/draft` (mounted at apps/api/main.go:4169 behind
 * `expensiveTenantLimit` + `write:campaigns`, manifest row reviewed) lands on
 * `Handler.draftSequence` (services/voice/internal/handlers/sequence_draft.go).
 * It takes `{brief, step_count?, tone?}`, spends ONE quota unit under the kind
 * `sequence_draft`, runs a single structured-JSON model call, and returns
 *   { "name": string, "rationale"?: string,
 *     "steps": [{subject, body, delay_hours, position}] }
 * WITHOUT PERSISTING ANYTHING (the package comment says so, and there is no
 * Save call on that path). So a draft is a proposal held in memory until the
 * operator saves it — which is exactly the shape the product decision asks
 * for: generated content lands as an editable draft the user reviews, never as
 * something live.
 *
 * WHY THIS MODULE IS IMPORT-FREE. Mobile's vitest runs in a NODE environment,
 * so anything that transitively reaches react-native cannot be imported by a
 * `.test.ts`. Every rule below is therefore pure, and `sequenceDraft.test.ts`
 * tests THESE functions rather than a rendered sheet.
 *
 * THE THREE SERVER CONTRACTS MIRRORED HERE, and why mirroring is not a second
 * authority: the server still decides, and its message is surfaced verbatim.
 * These exist so a request that cannot possibly succeed is refused before it
 * costs a round trip AND a quota unit — the difference from every other form in
 * this app, where a wasted round trip is only a wasted round trip.
 *   1. `draftBriefMaxRunes` = 8000, counted AFTER trimming (the handler trims
 *      first, then counts: sequence_draft.go:52-59).
 *   2. `draftToneMaxRunes` = 200, also counted after trimming (:65-69).
 *   3. `generation.DraftStepCountMax` = 10 (draft.go:27). The handler rejects
 *      `step_count > 10`; `<= 0` silently means the default of 5 (:101-107).
 *
 * AND THE FOURTH, which is the one that bites: what the SAVE will accept. A
 * draft is saved through `POST /api/v1/voice/sequences` with a `steps` array,
 * which runs `validateSteps` → `validateEmailConfig`. The drafting endpoint
 * only drops a step when subject AND body are both empty
 * (draft.go::parseSequenceDraftJSON), so a step with an EMPTY SUBJECT and a
 * good body is a perfectly normal draft response — and would 400 the entire
 * save with "email subject required". That half of the contract — everything
 * the SAVE will and will not accept — lives next door in `sequenceDraftSave`,
 * because it mirrors a different Go file and changes for different reasons.
 */

/** `draftBriefMaxRunes` (services/voice/.../sequence_draft.go:30). */
export const SEQUENCE_DRAFT_BRIEF_MAX_RUNES = 8000;
/** `draftToneMaxRunes` (:31). */
export const SEQUENCE_DRAFT_TONE_MAX_RUNES = 200;
/** `generation.DraftStepCountMax` (generation/draft.go:27). */
export const SEQUENCE_DRAFT_STEP_COUNT_MAX = 10;
/** `generation.DraftStepCountDefault` (:22) — what an omitted count means. */
export const SEQUENCE_DRAFT_STEP_COUNT_DEFAULT = 5;
/** The smallest count worth asking for. `<= 0` means "use the default"
 *  server-side, so mobile always sends an explicit value in 1..10. */
export const SEQUENCE_DRAFT_STEP_COUNT_MIN = 1;
/** `sequenceMaxDelaySeconds` = 365 days, expressed in the unit a draft uses. */
export const SEQUENCE_DRAFT_DELAY_MAX_HOURS = 365 * 24;

/** Rune count, matching Go's `utf8.RuneCountInString`. */
export function runeCount(value: string): number {
  return [...value].length;
}

export type SequenceDraftFieldCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

/**
 * The brief. Mirrors sequence_draft.go:52-59 exactly: trim, then require
 * non-empty, then bound the TRIMMED rune count. Control characters are NOT
 * rejected — a brief is multi-line free text and the handler treats it as
 * such.
 */
export function validateSequenceBrief(raw: string): SequenceDraftFieldCheck {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: "Describe the sequence you want before drafting.",
    };
  }
  if (runeCount(trimmed) > SEQUENCE_DRAFT_BRIEF_MAX_RUNES) {
    return {
      ok: false,
      error: `Briefs are limited to ${SEQUENCE_DRAFT_BRIEF_MAX_RUNES} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * The tone. Optional by contract — the handler documents "infer from the
 * brief; default to warm and direct" when it is absent — so an empty value is
 * `ok` and the caller omits the field entirely.
 */
export function validateSequenceDraftTone(
  raw: string,
): SequenceDraftFieldCheck {
  const trimmed = raw.trim();
  if (runeCount(trimmed) > SEQUENCE_DRAFT_TONE_MAX_RUNES) {
    return {
      ok: false,
      error: `Tone is limited to ${SEQUENCE_DRAFT_TONE_MAX_RUNES} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Bound a requested email count into the range the handler accepts.
 *
 * Clamps rather than rejects: this value comes from a stepper the operator
 * drives, never from free text, so the only way out of range is a bug — and
 * refusing to draft because of one is worse than drafting five.
 */
export function clampDraftStepCount(value: number): number {
  if (!Number.isFinite(value)) return SEQUENCE_DRAFT_STEP_COUNT_DEFAULT;
  const whole = Math.round(value);
  if (whole < SEQUENCE_DRAFT_STEP_COUNT_MIN) {
    return SEQUENCE_DRAFT_STEP_COUNT_MIN;
  }
  if (whole > SEQUENCE_DRAFT_STEP_COUNT_MAX) {
    return SEQUENCE_DRAFT_STEP_COUNT_MAX;
  }
  return whole;
}

/** One drafted email, after decoding. */
export interface SequenceDraftEmail {
  /** Stable local key. Positional and dense, so React keys survive an edit. */
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  /**
   * Hours to wait AFTER the previous email.
   *
   * `null` means the model gave no wait for this step — ABSENCE IS NOT ZERO,
   * and rendering a missing value as "Sends immediately" would be a claim the
   * response does not support. `formatDraftDelay` says which of the two it is.
   */
  readonly delayHours: number | null;
}

export interface SequenceDraftPlan {
  readonly name: string;
  /** The model's own explanation of the arc. Empty means it gave none. */
  readonly rationale: string;
  readonly emails: readonly SequenceDraftEmail[];
}

/**
 * Collapse anything that cannot survive `validateSingleLine` into spaces.
 *
 * A subject line is single-line BY DEFINITION, and the handler refuses CR, LF,
 * NUL and every other control rune on it. A model that wraps a long subject is
 * a formatting artifact, not content, so folding the whitespace is a faithful
 * reading of what it wrote — unlike silently truncating, which would lose it.
 */
function collapseToSingleLine(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }
  return out.replace(/\s+/gu, " ").trim();
}

/**
 * Strip the control characters `validateBody` refuses, keeping the three it
 * allows (\n, \r, \t) because those ARE an email body's structure.
 */
function stripUnsupportedBodyControls(value: string): string {
  let out = "";
  for (const char of value) {
    if (char === "\n" || char === "\r" || char === "\t") {
      out += char;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code === 0 || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    out += char;
  }
  return out;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/**
 * Hours from a wire `delay_hours`, or null when the field is missing or not a
 * finite number. Clamped into [0, 365 days] — the ceiling is
 * `sequenceMaxDelaySeconds`, which the SAVE enforces, so a model that invents
 * a two-year wait would otherwise 400 the whole sequence.
 */
function readDelayHours(source: Record<string, unknown>): number | null {
  const raw = source["delay_hours"];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const whole = Math.round(raw);
  if (whole <= 0) return 0;
  return Math.min(whole, SEQUENCE_DRAFT_DELAY_MAX_HOURS);
}

/**
 * Decode the draft response defensively.
 *
 * This walks a MODEL-SHAPED payload — the one class of response where "the
 * server always sends well-formed JSON" is the weakest assumption in the app —
 * so every field is checked rather than asserted. Returns null when nothing
 * usable came back, which the caller renders as "the model returned nothing we
 * could use", never as an empty success.
 *
 * Ordering mirrors the server's own normalisation (draft.go:157-207): drop a
 * step only when subject AND body are both empty, sort by the model's
 * `position`, then renumber densely — so a shuffled response cannot scramble
 * the arc.
 */
export function normalizeSequenceDraft(raw: unknown): SequenceDraftPlan | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const rawSteps = source["steps"];
  if (!Array.isArray(rawSteps)) return null;

  const decoded: { subject: string; body: string; delayHours: number | null; position: number }[] =
    [];
  rawSteps.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const step = entry as Record<string, unknown>;
    const subject = collapseToSingleLine(readString(step, "subject"));
    const body = stripUnsupportedBodyControls(readString(step, "body")).trim();
    if (subject === "" && body === "") return;
    const positionRaw = step["position"];
    const position =
      typeof positionRaw === "number" && Number.isFinite(positionRaw)
        ? positionRaw
        : index + 1;
    decoded.push({ subject, body, delayHours: readDelayHours(step), position });
  });
  if (decoded.length === 0) return null;

  decoded.sort((a, b) => a.position - b.position);
  const emails = decoded
    .slice(0, SEQUENCE_DRAFT_STEP_COUNT_MAX)
    .map((step, index) => ({
      id: `draft-email-${index + 1}`,
      subject: step.subject,
      body: step.body,
      delayHours: step.delayHours,
    }));

  return {
    name: collapseToSingleLine(readString(source, "name")),
    rationale: stripUnsupportedBodyControls(
      readString(source, "rationale"),
    ).trim(),
    emails,
  };
}

/** Human label for a drafted wait. */
export function formatDraftDelay(hours: number | null): string {
  if (hours === null) {
    // ABSENCE IS NOT ZERO: say the model gave nothing, then say what saving
    // will do about it, because those are two different facts.
    return "No wait given — follows immediately";
  }
  if (hours <= 0) return "Sends immediately";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `Waits ${days} day${days === 1 ? "" : "s"}`;
  }
  return `Waits ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * Human sentence for a failed draft, per the statuses THIS route can answer.
 *
 * The voice handler writes most failures with `http.Error`, i.e. plain text,
 * and its quota refusal with a JSON body whose `error` is the STRING
 * `"quota_exceeded"` (handlers/chat.go:428-436). Both reach the caller as
 * `code`/`message`, so the quota case is matched on the code rather than on
 * the bare 429 it shares with the gateway's own per-tenant limiter.
 */
export function sequenceDraftErrorMessage(
  status: number,
  fallback?: string | undefined,
  code?: string | undefined,
): string {
  const message = fallback?.trim();
  if (code === "quota_exceeded") {
    return "This workspace has used its AI allowance for today. It resets at midnight UTC.";
  }
  if (status === 401) {
    return "Your session expired. Sign in again to draft a sequence.";
  }
  if (status === 403) {
    return "Your role can't draft sequences. Ask an admin or an owner.";
  }
  if (status === 404 || status === 405 || status === 501) {
    return "This deployment doesn't expose AI sequence drafting. Use the desktop or web app.";
  }
  if (status === 408) {
    return "The draft took too long and was cancelled. Try a shorter brief.";
  }
  if (status === 429) {
    return "Too many AI requests just now. Wait a moment and try again.";
  }
  if (status === 503) {
    return "AI drafting isn't configured in this deployment yet.";
  }
  if (status === 502) {
    return "The model couldn't produce a usable sequence. Try again, or reword the brief.";
  }
  if (status >= 500) {
    return "The sequence service couldn't draft this. Try again shortly.";
  }
  if (status === 400) {
    return message || "That brief was rejected. Shorten it and try again.";
  }
  return message || "Couldn't draft this sequence.";
}

/**
 * Whether to offer "AI draft" at all.
 *
 * The interesting part is the `online` term, and how it DIFFERS from
 * `canCreateSequence` right beside it. A blank create is registered in the
 * offline mutation queue: with the network down it pauses, persists to the
 * encrypted vault and replays on reconnect, so hiding it offline would suppress
 * the one write on that screen built to survive being offline. A generation
 * cannot work that way. It spends a metered AI unit at an unpredictable later
 * moment, its whole output needs reviewing before it means anything, and the
 * operator would be three screens away when it landed. So this one is hidden
 * the moment the gate closes, exactly as DELETE is.
 *
 * The other three terms are `canCreateSequence`'s: an identity, an
 * editor-or-better role (`write:campaigns` at the mount site), and an endpoint
 * that is actually deployed here.
 */
export function canDraftSequenceWithAI(input: {
  hasTenant: boolean;
  /** The list read answered 404/405/501 — the family is not deployed here. */
  unavailable: boolean;
  /** Result of `canAccessMinimumRole("editor", role, mode)`. */
  canWrite: boolean;
  /** The online query gate is open AND there is no cached-session notice. */
  online: boolean;
}): boolean {
  return (
    input.hasTenant && !input.unavailable && input.canWrite && input.online
  );
}

/**
 * The sentence that has to sit on the review screen, above the emails.
 *
 * Two facts, both load-bearing and neither inferable from the other: a MODEL
 * wrote this text, and NOTHING has happened yet. The second is what stops
 * "draft with AI" from reading as "send with AI" — the endpoint persists
 * nothing, so until the operator saves, this sequence does not exist.
 */
export const SEQUENCE_DRAFT_REVIEW_NOTE =
  "A model wrote these emails from your brief. Nothing is saved or sent yet — review every line, then save it as a draft.";

/** The one sentence the BRIEF sheet owes the operator before it spends
 *  quota: what the request costs and what it will and will not produce. */
export const SEQUENCE_DRAFT_BRIEF_NOTE =
  "Uses one AI request from your workspace's daily allowance. You'll review the emails before anything is saved, and nothing sends from this app.";
