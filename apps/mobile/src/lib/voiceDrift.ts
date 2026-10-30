/**
 * lib/voiceDrift.ts — the pure reading of POST /api/v1/voice/drift.
 *
 * "Does this campaign still sound like us?" is a question the platform has
 * always been able to answer (services/voice/internal/handlers/drift.go runs
 * the fidelity evaluator against the tenant's MEASURED voice profile and folds
 * in the authored brand-voice rules apps/api attaches before proxying) and
 * that no mobile surface ever asked. AI-assisted copy written on a phone —
 * which is most of what mobile composes, via SubjectLineSuggestions and the
 * builder's inline AI — shipped unscored.
 *
 * Wire shape (drift.go `driftResponse`):
 *   { score: 0..100, severity: "ok"|"warn"|"critical", warn, critical,
 *     breakdown: { embedding_similarity, stylistic_distance,
 *                  vocabulary_overlap, structural_match, combined },
 *     profile_id?, authored_adjustment?, suggestions?: string[] }
 *
 * THE ONE TRAP THIS FILE EXISTS FOR: when the tenant has no voice profile the
 * handler answers `200 {score: 100, severity: "ok"}` with a zero-valued
 * breakdown and a single "no voice profile yet" suggestion (drift.go:96-106).
 * Rendered naively that is a perfect 100/100 green tick — an invented
 * measurement, the exact class of manufactured claim the Voice tab itself was
 * rebuilt to stop making. The zero breakdown is the tell: the evaluator never
 * returns 0 for `embedding_similarity` (it floors at 0.5 when no embedding
 * client is wired, evaluator.go:64-68), so an all-zero breakdown can only mean
 * "nothing was scored". That collapses to state `inactive` with a null score,
 * and the card renders an em-dash.
 *
 * Import-free on purpose beyond lib/format: mobile's vitest runs in a node
 * environment, so anything that reaches react-native cannot be unit-tested.
 * The request itself lives in src/api/voiceDrift.ts.
 */
import { EMDASH, plural } from "@/lib/format";

/** services/voice generation.FidelityBreakdown, over the wire. */
export interface VoiceDriftBreakdownWire {
  embedding_similarity?: number;
  stylistic_distance?: number;
  vocabulary_overlap?: number;
  structural_match?: number;
  combined?: number;
}

export interface VoiceDriftWire {
  score?: number;
  severity?: string;
  warn?: boolean;
  critical?: boolean;
  breakdown?: VoiceDriftBreakdownWire;
  profile_id?: string;
  authored_adjustment?: number;
  suggestions?: string[];
}

/**
 * `inactive` is NOT a severity the server sends — it is the fourth outcome
 * this client refuses to collapse into "ok": there was no baseline to score
 * against, so nothing was measured.
 */
export type VoiceDriftState = "ok" | "warn" | "critical" | "inactive";

export interface VoiceDriftComponent {
  key: string;
  label: string;
  /** 0..100, already rounded. */
  pct: number;
}

export interface VoiceDriftReading {
  state: VoiceDriftState;
  /** null when nothing was measured — absence is never zero. */
  score: number | null;
  /** "68" or the em-dash. Never "0" for an unmeasured check. */
  scoreLabel: string;
  headline: string;
  detail: string;
  components: VoiceDriftComponent[];
  suggestions: string[];
  /**
   * The signed delta the authored banned-term / descriptor overlay applied.
   * Negative means the copy used terms the brand profile flags as off-voice —
   * a categorically different (and more actionable) fact than a low corpus
   * score, so it is surfaced separately rather than folded into the number.
   */
  authoredAdjustment: number | null;
  profileId: string | null;
}

/** drift.go DriftWarnThreshold / DriftCriticalThreshold. */
export const VOICE_DRIFT_WARN_BELOW = 60;
export const VOICE_DRIFT_CRITICAL_BELOW = 40;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function componentPct(value: unknown): number | null {
  const n = finite(value);
  if (n === null) return null;
  // The evaluator emits 0..1 similarities; clamp defensively so a future
  // component that already reports a percentage cannot render as 3800%.
  const scaled = n <= 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

const COMPONENT_LABELS: readonly {
  key: keyof VoiceDriftBreakdownWire;
  label: string;
}[] = [
  { key: "stylistic_distance", label: "Sentence style" },
  { key: "vocabulary_overlap", label: "Vocabulary" },
  { key: "structural_match", label: "Structure" },
  { key: "embedding_similarity", label: "Semantic style" },
];

/**
 * True when the response carries no measurement at all: every breakdown
 * component absent or exactly zero. See the header — this is the "no voice
 * profile yet" answer, not a score of zero.
 */
function breakdownIsEmpty(br: VoiceDriftBreakdownWire | undefined): boolean {
  if (!br || typeof br !== "object") return true;
  const keys: (keyof VoiceDriftBreakdownWire)[] = [
    "embedding_similarity",
    "stylistic_distance",
    "vocabulary_overlap",
    "structural_match",
    "combined",
  ];
  for (const key of keys) {
    const n = finite(br[key]);
    if (n !== null && n !== 0) return false;
  }
  return true;
}

function normalizeSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function stateFor(score: number, severity: string | undefined): VoiceDriftState {
  // Trust the server's severity when it sent one we recognise; fall back to
  // the published thresholds so a trimmed proxy response still classifies.
  if (severity === "critical" || severity === "warn" || severity === "ok") {
    return severity;
  }
  if (score < VOICE_DRIFT_CRITICAL_BELOW) return "critical";
  if (score < VOICE_DRIFT_WARN_BELOW) return "warn";
  return "ok";
}

export function readVoiceDrift(raw: unknown): VoiceDriftReading {
  const wire = (raw && typeof raw === "object" ? raw : {}) as VoiceDriftWire;
  const suggestions = normalizeSuggestions(wire.suggestions);
  const components: VoiceDriftComponent[] = [];
  for (const spec of COMPONENT_LABELS) {
    const pct = componentPct(wire.breakdown?.[spec.key]);
    if (pct === null) continue;
    components.push({ key: spec.key, label: spec.label, pct });
  }

  if (breakdownIsEmpty(wire.breakdown)) {
    return {
      state: "inactive",
      score: null,
      scoreLabel: EMDASH,
      headline: "Voice check inactive",
      detail:
        suggestions[0] ??
        "No voice profile to compare against yet. Build one on the Voice tab and this send will be scored.",
      components: [],
      suggestions: [],
      authoredAdjustment: null,
      profileId: null,
    };
  }

  const score = finite(wire.score);
  if (score === null) {
    return {
      state: "inactive",
      score: null,
      scoreLabel: EMDASH,
      headline: "Voice check inactive",
      detail: "The voice service answered without a score.",
      components,
      suggestions,
      authoredAdjustment: null,
      profileId: null,
    };
  }

  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  const state = stateFor(rounded, wire.severity);
  const adjustment = finite(wire.authored_adjustment);
  const profileId =
    typeof wire.profile_id === "string" && wire.profile_id.trim()
      ? wire.profile_id.trim()
      : null;

  return {
    state,
    score: rounded,
    scoreLabel: String(rounded),
    headline:
      state === "critical"
        ? "This doesn't sound like you"
        : state === "warn"
          ? "Drifting from your voice"
          : "On voice",
    detail:
      state === "critical"
        ? `Scored ${rounded}/100 against your measured voice — below the ${VOICE_DRIFT_CRITICAL_BELOW} floor.`
        : state === "warn"
          ? `Scored ${rounded}/100 against your measured voice — below the ${VOICE_DRIFT_WARN_BELOW} mark.`
          : `Scored ${rounded}/100 against your measured voice.`,
    components,
    suggestions,
    authoredAdjustment: adjustment !== null && adjustment !== 0 ? adjustment : null,
    profileId,
  };
}

/**
 * What a screen reader says for the whole card, so the score, the verdict and
 * the component bars are announced as one sentence instead of six fragments.
 */
export function voiceDriftSpoken(
  reading: VoiceDriftReading | null | undefined,
): string {
  if (!reading) return "Voice fidelity has not been checked.";
  if (reading.state === "inactive") {
    return `Voice fidelity: not measured. ${reading.detail}`;
  }
  const parts = [`Voice fidelity ${reading.scoreLabel} out of 100. ${reading.headline}.`];
  if (reading.components.length > 0) {
    parts.push(
      reading.components.map((c) => `${c.label} ${c.pct} percent`).join(", ") + ".",
    );
  }
  if (reading.suggestions.length > 0) {
    parts.push(`${plural(reading.suggestions.length, "suggestion")}.`);
  }
  return parts.join(" ");
}

/**
 * True when the reading should escalate the send to a typed confirmation.
 *
 * Only `critical` does. A `warn` is information the operator is looking at
 * already; turning every stylistic wobble into a typed phrase would train
 * people to type through the one that mattered. This mirrors the link check,
 * which escalates on a broken link and not on a slow one.
 */
export function voiceDriftBlocks(
  reading: VoiceDriftReading | null | undefined,
): boolean {
  return reading?.state === "critical";
}

/** The consequence line for the send confirmation when drift is critical. */
export function voiceDriftConsequence(
  reading: VoiceDriftReading | null | undefined,
): string | null {
  if (!voiceDriftBlocks(reading) || !reading) return null;
  const parts = [
    `Voice fidelity ${reading.scoreLabel}/100 — below the ${VOICE_DRIFT_CRITICAL_BELOW} floor.`,
  ];
  if (reading.authoredAdjustment !== null && reading.authoredAdjustment < 0) {
    parts.push("The copy uses terms your brand voice flags as off-voice.");
  }
  const first = reading.suggestions[0];
  if (first) parts.push(first);
  return parts.join(" ");
}

/**
 * Whether there is anything to score. The gateway maps `html`/`text` onto the
 * scorer's `body` and the handler 400s on an empty one (drift.go:88-91), so a
 * Check button on an empty draft could only ever produce an error toast.
 */
export function canScoreVoiceDrift(
  bodyHtml: string | null | undefined,
): boolean {
  return typeof bodyHtml === "string" && bodyHtml.trim().length > 0;
}
