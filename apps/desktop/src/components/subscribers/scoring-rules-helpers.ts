/**
 * scoring-rules-helpers — pure logic for the Subscribers page
 * "Lead scoring" card (full-surface wiring #18).
 *
 * Wire (apps/api/internal/scoring/scoring.go, all routes ScopeAdmin):
 *
 *   GET  /api/v1/scoring/rules      → versioned rules/defaults/catalog
 *   PUT  /api/v1/scoring/rules      ← version-bound whole-set replacement
 *
 * Validation mirrors the Go handler: event types come from the closed server
 * catalog, weights are whole numbers in -1000..1000, notes are bounded, and
 * event types are unique. The response parser is deliberately fail-closed so
 * malformed server data never becomes an editable workspace-wide draft.
 */

import type {
  ScoringEventCatalogItem,
  ScoringRule,
  ScoringRulesResponse,
} from "../../lib/api-client";

/** Server-side bounds (scoring.go PutRules). */
export const SCORING_WEIGHT_MIN = -1000;
export const SCORING_WEIGHT_MAX = 1000;
export const SCORING_RULE_MAX_COUNT = 14;
export const SCORING_NOTE_MAX_CHARACTERS = 240;
const SCORING_VERSION_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SCORING_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const SCORING_CATALOG_LABEL_MAX_CHARACTERS = 120;
const SCORING_WINDOW_MAX_DAYS = 3650;

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validBoundedNote(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const note = value.trim();
  return (
    Array.from(note).length <= SCORING_NOTE_MAX_CHARACTERS &&
    !/\p{Cc}/u.test(note)
  );
}

function validWireRule(
  value: unknown,
  catalog: ReadonlySet<string>,
): value is ScoringRule {
  const candidate = record(value);
  return Boolean(
    candidate &&
    typeof candidate.id === "string" &&
    typeof candidate.event_type === "string" &&
    catalog.has(candidate.event_type) &&
    Number.isInteger(candidate.weight) &&
    (candidate.weight as number) >= SCORING_WEIGHT_MIN &&
    (candidate.weight as number) <= SCORING_WEIGHT_MAX &&
    validBoundedNote(candidate.note),
  );
}

/**
 * Runtime parser for the network response. TypeScript's declared wire type is
 * not evidence that untrusted JSON has the same shape, so the editor accepts
 * only a complete, internally consistent contract.
 */
export function parseScoringRulesResponse(
  value: unknown,
): ScoringRulesResponse | null {
  const response = record(value);
  if (
    !response ||
    !Array.isArray(response.rules) ||
    response.rules.length > SCORING_RULE_MAX_COUNT ||
    !Array.isArray(response.defaults) ||
    response.defaults.length === 0 ||
    response.defaults.length > SCORING_RULE_MAX_COUNT ||
    !Array.isArray(response.event_catalog) ||
    response.event_catalog.length === 0 ||
    response.event_catalog.length > SCORING_RULE_MAX_COUNT ||
    typeof response.version !== "string" ||
    !SCORING_VERSION_PATTERN.test(response.version) ||
    !Number.isInteger(response.window_days) ||
    (response.window_days as number) < 1 ||
    (response.window_days as number) > SCORING_WINDOW_MAX_DAYS
  ) {
    return null;
  }

  const categories = new Set(["engagement", "delivery", "consent", "profile"]);
  const catalogTypes = new Set<string>();
  const catalog: ScoringEventCatalogItem[] = [];
  for (const value of response.event_catalog) {
    const item = record(value);
    if (
      !item ||
      typeof item.event_type !== "string" ||
      !SCORING_EVENT_TYPE_PATTERN.test(item.event_type) ||
      catalogTypes.has(item.event_type) ||
      typeof item.label !== "string" ||
      item.label.trim() !== item.label ||
      item.label.length === 0 ||
      Array.from(item.label).length > SCORING_CATALOG_LABEL_MAX_CHARACTERS ||
      /\p{Cc}/u.test(item.label) ||
      typeof item.category !== "string" ||
      !categories.has(item.category)
    ) {
      return null;
    }
    catalogTypes.add(item.event_type);
    catalog.push({
      event_type: item.event_type,
      label: item.label,
      category: item.category as ScoringEventCatalogItem["category"],
    });
  }

  const seenRules = new Set<string>();
  const rules: ScoringRule[] = [];
  for (const value of response.rules) {
    if (!validWireRule(value, catalogTypes)) return null;
    if (seenRules.has(value.event_type)) return null;
    seenRules.add(value.event_type);
    rules.push({ ...value });
  }

  const seenDefaults = new Set<string>();
  const defaults: ScoringRule[] = [];
  for (const value of response.defaults) {
    if (!validWireRule(value, catalogTypes)) return null;
    if (seenDefaults.has(value.event_type)) return null;
    seenDefaults.add(value.event_type);
    defaults.push({ ...value });
  }

  return {
    rules,
    defaults,
    event_catalog: catalog,
    version: response.version,
    window_days: response.window_days as number,
  };
}

export function parseScoringSaveResponse(
  value: unknown,
  expectedSaved: number,
): { saved: number; version: string } | null {
  const response = record(value);
  if (
    !response ||
    !Number.isSafeInteger(response.saved) ||
    response.saved !== expectedSaved ||
    typeof response.version !== "string" ||
    !SCORING_VERSION_PATTERN.test(response.version)
  ) {
    return null;
  }
  return { saved: response.saved as number, version: response.version };
}

/** Editable row state — weight is a string so the input can hold
 * intermediate values ("-", "") without NaN flicker. */
export interface ScoringRuleDraft {
  /** Server id for existing rows; "" for unsaved rows. The PUT
   *  replaces the whole set, so the id is informational only. */
  id: string;
  event_type: string;
  weight: string;
  note: string;
}

export function draftFromScoringRule(rule: ScoringRule): ScoringRuleDraft {
  return {
    id: rule.id,
    event_type: rule.event_type,
    weight: String(rule.weight),
    note: rule.note ?? "",
  };
}

export function emptyScoringDraft(): ScoringRuleDraft {
  return { id: "", event_type: "", weight: "1", note: "" };
}

/**
 * Per-row validation errors keyed by row index. Empty object = valid.
 * Messages mirror the server's own validation copy so a client-side
 * rejection reads the same as a server-side one would.
 */
export function validateScoringDrafts(
  drafts: ScoringRuleDraft[],
  allowedEventTypes?: ReadonlySet<string>,
): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Map<string, number>();
  if (drafts.length > SCORING_RULE_MAX_COUNT) {
    errors[SCORING_RULE_MAX_COUNT] =
      `At most ${SCORING_RULE_MAX_COUNT} scoring rules are allowed.`;
  }
  drafts.forEach((d, i) => {
    const eventType = d.event_type.trim();
    if (eventType === "") {
      errors[i] = "Event type is required.";
      return;
    }
    if (allowedEventTypes && !allowedEventTypes.has(eventType)) {
      errors[i] =
        `Choose a current event from the server catalog; "${eventType}" can't be scored.`;
      return;
    }
    // NB: Number("") is 0 — an empty input must NOT silently become
    // weight 0, so blank is rejected before the numeric parse.
    const weight = d.weight.trim() === "" ? Number.NaN : Number(d.weight);
    if (!Number.isInteger(weight)) {
      errors[i] = "Weight must be a whole number.";
      return;
    }
    if (weight < SCORING_WEIGHT_MIN || weight > SCORING_WEIGHT_MAX) {
      errors[i] =
        `Weight must be ${SCORING_WEIGHT_MIN}..${SCORING_WEIGHT_MAX}.`;
      return;
    }
    const dup = seen.get(eventType);
    if (dup != null) {
      errors[i] =
        `Duplicate event type "${eventType}" — the engine applies one weight per event.`;
      return;
    }
    const note = d.note.trim();
    if (Array.from(note).length > SCORING_NOTE_MAX_CHARACTERS) {
      errors[i] =
        `Note must be at most ${SCORING_NOTE_MAX_CHARACTERS} characters.`;
      return;
    }
    if (/\p{Cc}/u.test(note)) {
      errors[i] = "Note can't contain control characters.";
      return;
    }
    seen.set(eventType, i);
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
  unchanged: number;
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
  let unchanged = 0;
  for (const [eventType, next] of after) {
    const prior = before.get(eventType);
    if (!prior) {
      added += 1;
    } else if (JSON.stringify(prior) === JSON.stringify(next)) {
      unchanged += 1;
    } else {
      changed += 1;
    }
  }
  for (const eventType of before.keys()) {
    if (!after.has(eventType)) removed += 1;
  }
  return {
    added,
    changed,
    removed,
    unchanged,
    switchesToDefaults: baseline.length > 0 && current.length === 0,
  };
}

/** Convert validated drafts to the PUT wire shape (trimmed, parsed). */
export function draftsToScoringRules(
  drafts: ScoringRuleDraft[],
): ScoringRule[] {
  return drafts.map((d) => {
    const note = d.note.trim();
    return {
      id: d.id,
      event_type: d.event_type.trim(),
      weight: Number(d.weight),
      ...(note ? { note } : {}),
    };
  });
}

export interface ScoringDefaultRow {
  event_type: string;
  weight: number;
}

/**
 * Normalize a validated defaults array for stable presentation. The legacy map
 * branch remains only for migrations/tests; parseScoringRulesResponse never
 * permits that stale shape into the live editor.
 */
export function normalizeScoringDefaults(value: unknown): ScoringDefaultRow[] {
  const out: ScoringDefaultRow[] = [];
  if (Array.isArray(value)) {
    for (const v of value) {
      if (v && typeof v === "object") {
        const rec = v as Record<string, unknown>;
        if (
          typeof rec.event_type === "string" &&
          rec.event_type !== "" &&
          typeof rec.weight === "number" &&
          Number.isFinite(rec.weight)
        ) {
          out.push({ event_type: rec.event_type, weight: rec.weight });
        }
      }
    }
  } else if (value && typeof value === "object") {
    for (const [eventType, weight] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        eventType !== "" &&
        typeof weight === "number" &&
        Number.isFinite(weight)
      ) {
        out.push({ event_type: eventType, weight });
      }
    }
  }
  out.sort((a, b) => a.event_type.localeCompare(b.event_type));
  return out;
}
