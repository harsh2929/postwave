/**
 * lib/scoring-taxonomy-api.ts — lead scoring and tag taxonomy.
 *
 * Five paths were reached by desktop and by no web file: scoring/rules,
 * tag-taxonomy, tag-groups, subscription-types and utm-templates.
 *
 * `scoring/rules` RETURNS `defaults` AND `rules` SEPARATELY, and the empty
 * case is the interesting one: 0 custom rules with 6 defaults means scoring IS
 * running, on the built-in weights. A UI that reports "0 rules" implies no
 * scoring at all — the opposite. The defaults are the operative set until
 * somebody overrides them, so both counts are carried.
 *
 * `tag-taxonomy` distinguishes `registered` tags from ones merely seen on a
 * subscriber, and reports `subscribers: 0` for a registered tag nobody has —
 * which is a real state (declared, unused), not a missing row.
 *
 * COVERAGE: this module wires 4 of them:
 *   /api/v1/scoring/rules
 *   /api/v1/subscription-types
 *   /api/v1/tag-taxonomy
 *   /api/v1/utm-templates
 * The remaining 1 are not called from web. The sentence above
 * describes the gap that was found, not the part that was closed.
 */
import { api } from "@/lib/api";

export interface ScoringRule {
  id: string;
  event_type: string;
  weight: number;
  /** Optional operator note (≤240 characters server-side). */
  note?: string;
}

export interface ScoringEvent {
  event_type: string;
  label: string;
  category?: string;
}

export interface ScoringConfig {
  /** Built-in weights, in force ONLY while no custom rule is saved. */
  defaults: ScoringRule[];
  /** Workspace rules. Empty does NOT mean scoring is off — see `defaults`. */
  rules: ScoringRule[];
  event_catalog: ScoringEvent[];
  /**
   * The rule-set version (`sha256:…`) a PUT must echo as `expected_version`.
   * "" when the server sent none — a save is then refused client-side.
   */
  version: string;
  window_days?: number;
}

export interface TaxonomyTag {
  tag: string;
  subscribers: number;
  /** Declared in the taxonomy rather than merely observed. */
  registered: boolean;
  created_at?: string;
}

export interface SubscriptionType {
  id: string;
  name: string;
  description: string;
  channel: string;
  is_default: boolean;
  is_internal: boolean;
  sort_order: number;
}

export interface UtmTemplate {
  id: string;
  campaign_id: string;
  is_default: boolean;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  enabled: boolean;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

function parseScoringRule(raw: Partial<ScoringRule> | null): ScoringRule {
  const note = typeof raw?.note === "string" ? raw.note : "";
  return {
    id: typeof raw?.id === "string" ? raw.id : "",
    event_type: typeof raw?.event_type === "string" ? raw.event_type : "",
    weight: num(raw?.weight),
    ...(note ? { note } : {}),
  };
}

export async function getScoringConfig(): Promise<ScoringConfig> {
  const res = await api.get<Partial<ScoringConfig>>("/api/v1/scoring/rules");
  return {
    defaults: asArray<Partial<ScoringRule>>(res?.defaults).map(parseScoringRule),
    rules: asArray<Partial<ScoringRule>>(res?.rules).map(parseScoringRule),
    event_catalog: asArray<ScoringEvent>(res?.event_catalog),
    version: typeof res?.version === "string" ? res.version : "",
    window_days: res?.window_days,
  };
}

export async function getTagTaxonomy(): Promise<TaxonomyTag[]> {
  const res = await api.get<{ items?: unknown }>("/api/v1/tag-taxonomy");
  return asArray<TaxonomyTag>(res?.items).map((t) => ({
    tag: String(t?.tag ?? ""),
    subscribers: num(t?.subscribers),
    registered: t?.registered === true,
    created_at: t?.created_at,
  }));
}

export async function listSubscriptionTypes(): Promise<SubscriptionType[]> {
  // Bare array — the third such endpoint found in this sweep.
  const res = await api.get<unknown>("/api/v1/subscription-types");
  return asArray<Partial<SubscriptionType>>(res).map((type) => ({
    id: String(type?.id ?? ""),
    name: String(type?.name ?? "Untitled type"),
    description: String(type?.description ?? ""),
    channel: String(type?.channel ?? "all"),
    is_default: type?.is_default === true,
    is_internal: type?.is_internal === true,
    sort_order: num(type?.sort_order),
  }));
}

export async function listUtmTemplates(): Promise<UtmTemplate[]> {
  const res = await api.get<{ templates?: unknown }>("/api/v1/utm-templates");
  return asArray<Partial<UtmTemplate>>(res?.templates).map((template) => ({
    id: String(template?.id ?? ""),
    campaign_id: String(template?.campaign_id ?? ""),
    is_default: template?.is_default === true,
    utm_source: String(template?.utm_source ?? ""),
    utm_medium: String(template?.utm_medium ?? ""),
    utm_campaign: String(template?.utm_campaign ?? ""),
    utm_term: String(template?.utm_term ?? ""),
    utm_content: String(template?.utm_content ?? ""),
    enabled: template?.enabled !== false,
  }));
}

/**
 * The weights actually in force. The engine (scoring.go RecomputeTenant) uses
 * the workspace rules when ANY exist and the built-in defaults only when none
 * do — custom rules replace the defaults entirely; they are not merged over
 * them. So one custom rule means every other event scores zero.
 */
export function effectiveWeights(config: ScoringConfig): ScoringRule[] {
  return config.rules.length > 0 ? config.rules : config.defaults;
}

/* ------------------------------------------------------------------ *
 * Lead-scoring rules editor (parity row audience-45).
 *
 * PUT /api/v1/scoring/rules (ScopeAdmin) REPLACES THE WHOLE SET and is
 * version-bound: the body echoes the `version` the draft was loaded against as
 * `expected_version`, and the server answers 409 `scoring_rules_conflict` when
 * another administrator saved in between. Validation mirrors scoring.go
 * normalizeRules so the form names the row before a round trip; a 422 still
 * renders the server's own sentence.
 * ------------------------------------------------------------------ */

export const SCORING_WEIGHT_MIN = -1000;
export const SCORING_WEIGHT_MAX = 1000;
export const SCORING_RULE_MAX_COUNT = 14;
export const SCORING_NOTE_MAX_CHARACTERS = 240;
const SCORING_VERSION_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function isScoringVersion(value: string): boolean {
  return SCORING_VERSION_PATTERN.test(value);
}

/** Editable row — weight stays a string so "-" or "" can be typed. */
export interface ScoringRuleDraft {
  event_type: string;
  weight: string;
  note: string;
}

export function draftFromScoringRule(rule: ScoringRule): ScoringRuleDraft {
  return {
    event_type: rule.event_type,
    weight: String(rule.weight),
    note: rule.note ?? "",
  };
}

export function emptyScoringDraft(): ScoringRuleDraft {
  return { event_type: "", weight: "1", note: "" };
}

/** Per-row errors keyed by row index; empty object = submittable. */
export function validateScoringDrafts(
  drafts: ScoringRuleDraft[],
  allowedEventTypes: ReadonlySet<string>,
): Record<number, string> {
  const errors: Record<number, string> = {};
  if (drafts.length > SCORING_RULE_MAX_COUNT) {
    errors[SCORING_RULE_MAX_COUNT] =
      `At most ${SCORING_RULE_MAX_COUNT} scoring rules are allowed.`;
  }
  const seen = new Set<string>();
  drafts.forEach((draft, index) => {
    const eventType = draft.event_type.trim();
    if (!eventType) {
      errors[index] = "Event type is required.";
      return;
    }
    if (!allowedEventTypes.has(eventType)) {
      errors[index] =
        `Choose a current event from the server catalog; "${eventType}" can't be scored.`;
      return;
    }
    // Number("") is 0 — a blank weight must not silently become zero.
    const weight = draft.weight.trim() === "" ? NaN : Number(draft.weight);
    if (!Number.isInteger(weight)) {
      errors[index] = "Weight must be a whole number.";
      return;
    }
    if (weight < SCORING_WEIGHT_MIN || weight > SCORING_WEIGHT_MAX) {
      errors[index] =
        `Weight must be ${SCORING_WEIGHT_MIN}..${SCORING_WEIGHT_MAX}.`;
      return;
    }
    if (seen.has(eventType)) {
      errors[index] =
        `Duplicate event type "${eventType}" — the engine applies one weight per event.`;
      return;
    }
    const note = draft.note.trim();
    if (Array.from(note).length > SCORING_NOTE_MAX_CHARACTERS) {
      errors[index] =
        `Note must be at most ${SCORING_NOTE_MAX_CHARACTERS} characters.`;
      return;
    }
    if (/\p{Cc}/u.test(note)) {
      errors[index] = "Note can't contain control characters.";
      return;
    }
    seen.add(eventType);
  });
  return errors;
}

interface CanonicalScoringRule {
  event_type: string;
  weight: number | null;
  note: string;
}

function canonicalDrafts(drafts: ScoringRuleDraft[]): CanonicalScoringRule[] {
  return drafts
    .map((draft) => ({
      event_type: draft.event_type.trim(),
      weight:
        draft.weight.trim() !== "" && Number.isInteger(Number(draft.weight))
          ? Number(draft.weight)
          : null,
      note: draft.note.trim(),
    }))
    .sort((left, right) => left.event_type.localeCompare(right.event_type));
}

/** Semantic equality: order and surrounding whitespace do not count. */
export function scoringDraftsEqual(
  left: ScoringRuleDraft[],
  right: ScoringRuleDraft[],
): boolean {
  return (
    JSON.stringify(canonicalDrafts(left)) ===
    JSON.stringify(canonicalDrafts(right))
  );
}

export interface ScoringRulesDiff {
  added: number;
  changed: number;
  removed: number;
  /** True when a non-empty set becomes empty: the defaults take over. */
  switchesToDefaults: boolean;
}

export function diffScoringDrafts(
  baseline: ScoringRuleDraft[],
  current: ScoringRuleDraft[],
): ScoringRulesDiff {
  const before = new Map(
    canonicalDrafts(baseline).map((rule) => [rule.event_type, rule]),
  );
  const after = new Map(
    canonicalDrafts(current).map((rule) => [rule.event_type, rule]),
  );
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [eventType, next] of after) {
    const prior = before.get(eventType);
    if (!prior) added += 1;
    else if (JSON.stringify(prior) !== JSON.stringify(next)) changed += 1;
  }
  for (const eventType of before.keys()) {
    if (!after.has(eventType)) removed += 1;
  }
  return {
    added,
    changed,
    removed,
    switchesToDefaults: baseline.length > 0 && current.length === 0,
  };
}

/** The confirm sentence for a reviewed save (desktop's wording). */
export function describeScoringDiff(diff: ScoringRulesDiff): string {
  return `This version-bound save adds ${diff.added}, changes ${diff.changed}, and removes ${diff.removed} rule${diff.removed === 1 ? "" : "s"}. ${
    diff.switchesToDefaults
      ? "Removing every custom rule switches the workspace back to the published default weights."
      : "Unchanged rules remain semantically identical."
  }`;
}

export interface ScoringSaveReceipt {
  saved: number;
  version: string;
}

/**
 * PUT /api/v1/scoring/rules (ScopeAdmin) — version-bound whole-set replace.
 * Online-only: a queued replay of a version-bound save would either conflict
 * or overwrite whatever an administrator saved in the meantime.
 */
export async function putScoringRules(
  drafts: ScoringRuleDraft[],
  expectedVersion: string,
): Promise<ScoringSaveReceipt> {
  const rules = drafts.map((draft) => {
    const note = draft.note.trim();
    return {
      event_type: draft.event_type.trim(),
      weight: Number(draft.weight),
      ...(note ? { note } : {}),
    };
  });
  const res = await api.put<Partial<ScoringSaveReceipt>>(
    "/api/v1/scoring/rules",
    { rules, expected_version: expectedVersion },
    { requireOnline: true },
  );
  if (
    !Number.isSafeInteger(res?.saved) ||
    res?.saved !== rules.length ||
    typeof res?.version !== "string" ||
    !isScoringVersion(res.version)
  ) {
    throw new Error(
      "The save response did not carry a versioned receipt. Refresh the rules before another change.",
    );
  }
  return { saved: res.saved, version: res.version };
}
