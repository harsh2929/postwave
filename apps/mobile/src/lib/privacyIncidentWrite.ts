/**
 * lib/privacyIncidentWrite.ts — the pure half of the two incident WRITES this
 * client now carries: declaring a preliminary record and moving the state
 * machine (open → contained → notifications_pending).
 *
 * WHY THESE WRITES EXIST ON A PHONE AT ALL. The register exists for the moment
 * someone learns of a possible breach — which is precisely the moment they are
 * least likely to be at a desk. Declaring opens the operational record and
 * starts the legacy 72-hour operational target; marking a breach contained
 * from the road is the state machine doing its job. Both are deliberately
 * ONLINE-ONLY and never enter the offline outbox: a breach declaration or a
 * state move replayed hours later, out of context, would invent the very audit
 * evidence the endpoint exists to capture honestly.
 *
 * WHAT STAYS HELD. Closure (`to: "closed"`) is release-held SERVER-WIDE
 * (incidents.go:567 answers 503 `incident_closure_release_hold` before
 * touching the database), as are counsel sign-off, notification evidence and
 * packet generation. Nothing here wires any of them.
 *
 * THE VALIDATION MIRRORS THE SERVER, field for field (incidents.go):
 *   - summary: required, ≤ 4000 runes (`incidentSummaryMaxRunes`)
 *   - reason:  required, ≤ 2000 runes (`incidentTransitionReasonMaxRunes`)
 *   - both reject NUL and bidirectional formatting characters
 *     (`containsUnsafeNarrativeControl`), because a narrative field that can
 *     reorder its own reading is not audit evidence.
 *
 * DELIBERATELY IMPORT-FREE apart from sibling pure modules, so it runs under
 * the node vitest environment.
 */
import { num } from "@/lib/format";
import type { IncidentSeverity, IncidentState } from "@/lib/privacyIncidents";

export const INCIDENT_SUMMARY_MAX_RUNES = 4000;
export const INCIDENT_REASON_MAX_RUNES = 2000;

export interface IncidentSeverityOption {
  value: IncidentSeverity;
  label: string;
  /** What choosing this grade claims — spoken beside the chip. */
  hint: string;
}

/**
 * `investigating` leads because it is the server's own default for an omitted
 * severity (incidents.go `normalizeSeverity`): "nobody has graded this yet" is
 * the honest first answer for a record opened under time pressure, and putting
 * it first keeps the declare flow from forcing a grade nobody established.
 */
export const INCIDENT_SEVERITY_OPTIONS: readonly IncidentSeverityOption[] = [
  {
    value: "investigating",
    label: "Investigating",
    hint: "Not graded yet — the honest default while facts are still arriving.",
  },
  {
    value: "low",
    label: "Low",
    hint: "Limited scope, unlikely to require notification.",
  },
  {
    value: "medium",
    label: "Medium",
    hint: "Meaningful exposure; response needed on a normal clock.",
  },
  {
    value: "high",
    label: "High",
    hint: "Serious exposure; response cannot wait.",
  },
  {
    value: "critical",
    label: "Critical",
    hint: "Severe exposure; treat as an active emergency.",
  },
];

/**
 * Mirrors `containsUnsafeNarrativeControl` (incidents.go): NUL, ALM, LRM/RLM,
 * the LRE..RLO embedding block, and the LRI..NOMINAL isolate block.
 */
export function containsUnsafeNarrativeControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      code === 0x0000 ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x206f)
    ) {
      return true;
    }
  }
  return false;
}

/** Rune count the way the server counts (code points, not UTF-16 units). */
function runeCount(value: string): number {
  return [...value].length;
}

function narrativeIssue(
  raw: string,
  noun: string,
  maxRunes: number,
): string | null {
  const text = raw.trim();
  if (!text) return `A ${noun} is required.`;
  if (runeCount(text) > maxRunes) {
    return `The ${noun} must be at most ${num(maxRunes)} characters.`;
  }
  if (containsUnsafeNarrativeControl(text)) {
    return `The ${noun} cannot contain invisible control or direction-formatting characters.`;
  }
  return null;
}

/** null when the summary would be accepted; otherwise the sentence to show. */
export function incidentSummaryIssue(raw: string): string | null {
  return narrativeIssue(raw, "summary", INCIDENT_SUMMARY_MAX_RUNES);
}

/** null when the reason would be accepted; otherwise the sentence to show. */
export function incidentReasonIssue(raw: string): string | null {
  return narrativeIssue(raw, "reason", INCIDENT_REASON_MAX_RUNES);
}

/**
 * Whether a failed declare may REUSE its Idempotency-Key on retry.
 *
 * The create endpoint requires an Idempotency-Key precisely so an ambiguous
 * outcome (network died, gateway 5xx — the request may have landed) can be
 * retried without opening a second breach record. A DEFINITE rejection
 * (4xx validation, 403) proves nothing was written, so the next attempt is a
 * new request and must carry a new key — reusing the old one after editing the
 * draft would replay-match a payload that never committed.
 */
export function declareKeyAfterFailure(error: {
  status?: number | undefined;
}): "reuse" | "rotate" {
  const status = typeof error.status === "number" ? error.status : 0;
  if (status === 0 || status >= 500 || status === 408 || status === 429) {
    return "reuse";
  }
  return "rotate";
}

export const INCIDENT_DECLARE_AMBIGUOUS_NOTICE =
  "The declare request may have reached the server, but its outcome could not be verified. Retrying resends the exact same request — it cannot open a duplicate record. Check the register before discarding this draft.";

/**
 * The `expected_from` a transition must carry, or null when no state fresh
 * enough to assert exists.
 *
 * The VERIFIED detail wins: the sheet re-fetches it on open with
 * `staleTime: 0`, so it is the newest recorded state this client holds. The
 * list row is the fallback for the window before that read lands. A build
 * that cannot name the current state sends nothing — the endpoint requires
 * `expected_from`, and inventing one would convert the server's stale-state
 * conflict protection into a lie.
 */
export function transitionExpectedFrom(
  verifiedStatus: IncidentState | null | undefined,
  rowStatus: IncidentState | null | undefined,
): IncidentState | null {
  return verifiedStatus ?? rowStatus ?? null;
}

/** The conflict codes after which the record must be re-read before retrying. */
export function transitionNeedsFreshRead(code: string | undefined): boolean {
  return (
    code === "stale_incident_state" ||
    code === "transition_conflict" ||
    code === "no_op" ||
    code === "invalid_transition"
  );
}
