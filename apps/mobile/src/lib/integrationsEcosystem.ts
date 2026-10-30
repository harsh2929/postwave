/**
 * lib/integrationsEcosystem.ts — the three ecosystem-level integration reports,
 * parsed for a phone.
 *
 *   GET /api/v1/integrations/coverage   → CoverageReport   (coverage.go:6)
 *   GET /api/v1/integrations/readiness  → ReadinessReport  (readiness.go:6)
 *   GET /api/v1/integrations/stacks     → StackReport      (stacks.go:8)
 *
 * All three are admin in the generated manifest, all three are computed from
 * the same catalog + recipe pair the browser reads, and all three exist to
 * answer a question the catalog list cannot: not "does an X connector exist"
 * but "how much of the ecosystem do we actually cover, and may we say so".
 *
 * ── MISSING IS NOT ZERO ────────────────────────────────────────────────────
 * Every numeric field here parses to `number | null`, and null renders as an
 * em-dash rather than 0. These reports are read as verdicts: "0 blockers" and
 * "the server didn't send blocker counts" produce opposite decisions, and a
 * report whose whole purpose is gating a public claim is the worst possible
 * place to turn an absence into an all-clear.
 *
 * ── THE SENTENCES ARE THE SERVER'S ─────────────────────────────────────────
 * `public_claim` (readiness.go:409), each check's `message`, each issue's
 * `message`/`remediation`, each recommendation, and each stack's `next_actions`
 * are written by the server and rendered verbatim. `public_claim` in particular
 * is the release gate's verdict on a MARKETING claim — the UI says which claim
 * the gate currently permits and never restates it as product fact.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A finite number, or null. Never a defaulted 0. */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = str(entry);
    if (s) out.push(s);
  }
  return out;
}

function countMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = numOrNull(raw);
    if (n !== null) out[key] = n;
  }
  return out;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .map((row) => row as Record<string, unknown>);
}

/* ── coverage ─────────────────────────────────────────────────────────────── */

export interface CoverageTarget {
  /** Reader-facing name of the measure. */
  label: string;
  value: number | null;
  target: number | null;
  /** The server's own parity verdict for this measure. */
  parity: boolean | null;
}

export interface CategoryCoverageView {
  key: string;
  label: string;
  total: number | null;
  nativeManaged: number | null;
  bridgeReady: number | null;
  planned: number | null;
  /** Server maturity token, verbatim. */
  maturity: string;
}

export interface PriorityGapView {
  slug: string;
  name: string;
  category: string;
  badge: string;
  runtimeStatus: string;
  bridgeAvailable: boolean;
  /** The server's sentence for why this is a gap. */
  reason: string;
}

export interface CoverageView {
  targets: CoverageTarget[];
  bridgeReady: number | null;
  planned: number | null;
  availableRecipes: number | null;
  categories: CategoryCoverageView[];
  priorityGaps: PriorityGapView[];
}

const MATURITY_LABELS: Readonly<Record<string, string>> = {
  verified_hybrid_ready: "Verified + bridge",
  verified_native_ready: "Verified native",
  foundation_hybrid_ready: "Foundation + bridge",
  foundation_cataloged: "Foundation only",
  bridge_ready: "Bridge only",
  planned_only: "Planned only",
  catalog_only: "Catalog only",
  empty: "Empty",
};

/** A maturity token as a reader word. Unknown tokens render verbatim. */
export function coverageMaturityLabel(maturity: string): string {
  return MATURITY_LABELS[maturity] ?? (maturity || "Unclassified");
}

export function normalizeCoverageReport(payload: unknown): CoverageView {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    targets: [
      {
        label: "Public catalog entries",
        value: numOrNull(raw.public_entries),
        target: numOrNull(raw.target_public_entries),
        parity: boolOrNull(raw.public_parity),
      },
      {
        label: "Native-managed connectors",
        value: numOrNull(raw.native_managed),
        target: numOrNull(raw.target_native_managed),
        parity: boolOrNull(raw.native_parity),
      },
      {
        label: "Native-verified connectors",
        value: numOrNull(raw.native_verified),
        target: numOrNull(raw.target_native_verified),
        parity: boolOrNull(raw.native_verification_parity),
      },
    ],
    bridgeReady: numOrNull(raw.bridge_ready),
    planned: numOrNull(raw.planned),
    availableRecipes: numOrNull(raw.available_recipes),
    categories: rows(raw.categories).map((row) => ({
      key: str(row.key),
      label: str(row.label) || str(row.key),
      total: numOrNull(row.total),
      nativeManaged: numOrNull(row.native_managed),
      bridgeReady: numOrNull(row.bridge_ready),
      planned: numOrNull(row.planned),
      maturity: str(row.maturity),
    })),
    priorityGaps: rows(raw.priority_gaps)
      .map((row) => ({
        slug: str(row.slug),
        name: str(row.name),
        category: str(row.category),
        badge: str(row.current_badge),
        runtimeStatus: str(row.runtime_status),
        bridgeAvailable: row.bridge_available === true,
        reason: str(row.reason),
      }))
      .filter((gap) => gap.slug !== ""),
  };
}

/**
 * "186 of 350" — or null when either half is missing, because "186 of —" reads
 * as a shortfall the server never reported.
 */
export function coverageTargetLine(target: CoverageTarget): string | null {
  if (target.value === null || target.target === null) return null;
  return `${target.value} of ${target.target}`;
}

/* ── readiness ────────────────────────────────────────────────────────────── */

export interface ReadinessCheckView {
  key: string;
  label: string;
  /** "pass" | "fail" from the server. */
  state: string;
  /** "ok" | "blocker" | "warning" from the server. */
  severity: string;
  count: number | null;
  message: string;
}

export interface ReadinessIssueView {
  key: string;
  severity: string;
  name: string;
  category: string;
  message: string;
  remediation: string;
}

export interface ReadinessView {
  ready: boolean | null;
  marketable: boolean | null;
  /** The server's claim sentence. Rendered verbatim, never restated. */
  publicClaim: string;
  checks: ReadinessCheckView[];
  issues: ReadinessIssueView[];
  issueCounts: Record<string, number>;
  recommendations: string[];
}

export function normalizeReadinessReport(payload: unknown): ReadinessView {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    ready: boolOrNull(raw.ready),
    marketable: boolOrNull(raw.marketable_public_claim),
    publicClaim: str(raw.public_claim),
    checks: rows(raw.checks)
      .map((row) => ({
        key: str(row.key),
        label: str(row.label),
        state: str(row.state),
        severity: str(row.severity),
        count: numOrNull(row.count),
        message: str(row.message),
      }))
      .filter((check) => check.key !== ""),
    issues: rows(raw.issues)
      .map((row) => ({
        key: str(row.key),
        severity: str(row.severity),
        name: str(row.name),
        category: str(row.category),
        message: str(row.message),
        remediation: str(row.remediation),
      }))
      .filter((issue) => issue.message !== ""),
    issueCounts: countMap(raw.issue_counts),
    recommendations: strList(raw.recommendations),
  };
}

/** Failing checks first: a report read at arm's length must lead with the no. */
export function readinessChecksByOutcome(
  view: ReadinessView,
): ReadinessCheckView[] {
  const failed = view.checks.filter((check) => check.state !== "pass");
  const passed = view.checks.filter((check) => check.state === "pass");
  return [...failed, ...passed];
}

export type EcosystemTone = "success" | "warning" | "danger" | "neutral";

export function readinessCheckTone(check: ReadinessCheckView): EcosystemTone {
  if (check.state === "pass") return "success";
  if (check.severity === "blocker") return "danger";
  if (check.severity === "warning") return "warning";
  return "neutral";
}

/**
 * The one-line verdict.
 *
 * Returns null when the server sent no `ready` boolean — the alternative is a
 * screen that says "Not ready" because a field was absent, which is a verdict
 * the client invented.
 */
export function readinessVerdictLine(view: ReadinessView): string | null {
  if (view.ready === null) return null;
  const blockers = view.issueCounts["severity:blocker"];
  const suffix =
    typeof blockers === "number"
      ? ` ${blockers === 1 ? "1 blocker" : `${blockers} blockers`}.`
      : "";
  return view.ready
    ? `Release gate passes.${suffix}`
    : `Release gate does not pass.${suffix}`;
}

/* ── stacks ───────────────────────────────────────────────────────────────── */

export interface StackView {
  key: string;
  name: string;
  segment: string;
  summary: string;
  /** "ready" | "covered" | "partial" | "gap" | "empty" from the server. */
  status: string;
  coveragePct: number | null;
  requiredCovered: number | null;
  requiredTotal: number | null;
  plannedGaps: string[];
  nextActions: string[];
}

export interface StackGapView {
  slug: string;
  name: string;
  stacks: number | null;
  reason: string;
}

export interface StacksView {
  targetCoveragePct: number | null;
  coveredPct: number | null;
  coveredStacks: number | null;
  totalStacks: number | null;
  stacks: StackView[];
  highestImpactGaps: StackGapView[];
}

const STACK_STATUS_LABELS: Readonly<Record<string, string>> = {
  ready: "Ready",
  covered: "Covered",
  partial: "Partial",
  gap: "Gap",
  empty: "Empty",
};

export function stackStatusLabel(status: string): string {
  return STACK_STATUS_LABELS[status] ?? (status || "Unknown");
}

export function stackStatusTone(status: string): EcosystemTone {
  if (status === "ready") return "success";
  if (status === "covered") return "success";
  if (status === "partial") return "warning";
  if (status === "gap") return "danger";
  return "neutral";
}

export function normalizeStackReport(payload: unknown): StacksView {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    targetCoveragePct: numOrNull(raw.target_coverage_pct),
    coveredPct: numOrNull(raw.covered_pct),
    coveredStacks: numOrNull(raw.covered_stacks),
    totalStacks: numOrNull(raw.total_stacks),
    stacks: rows(raw.stacks)
      .map((row) => ({
        key: str(row.key),
        name: str(row.name),
        segment: str(row.segment),
        summary: str(row.summary),
        status: str(row.status),
        coveragePct: numOrNull(row.coverage_pct),
        requiredCovered: numOrNull(row.required_covered),
        requiredTotal: numOrNull(row.required_total),
        plannedGaps: strList(row.planned_gaps),
        nextActions: strList(row.next_actions),
      }))
      .filter((stack) => stack.key !== ""),
    highestImpactGaps: rows(raw.highest_impact_gaps)
      .map((row) => ({
        slug: str(row.slug),
        name: str(row.name),
        stacks: numOrNull(row.stacks),
        reason: str(row.reason),
      }))
      .filter((gap) => gap.slug !== ""),
  };
}

/**
 * "8 of 10 stacks covered (80%, target 90%)" — every clause dropped
 * independently when the server did not send its number.
 */
export function stackCoverageLine(view: StacksView): string | null {
  if (view.coveredStacks === null || view.totalStacks === null) return null;
  const parts: string[] = [];
  if (view.coveredPct !== null) parts.push(`${view.coveredPct}%`);
  if (view.targetCoveragePct !== null) {
    parts.push(`target ${view.targetCoveragePct}%`);
  }
  const tail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${view.coveredStacks} of ${view.totalStacks} stacks covered${tail}`;
}

/** Worst first: gap, partial, then covered/ready, then anything unknown. */
export function stacksByUrgency(view: StacksView): StackView[] {
  const rank = (status: string): number => {
    if (status === "gap") return 0;
    if (status === "partial") return 1;
    if (status === "covered") return 2;
    if (status === "ready") return 3;
    return 9;
  };
  return [...view.stacks].sort((left, right) => {
    const delta = rank(left.status) - rank(right.status);
    return delta !== 0 ? delta : left.name.localeCompare(right.name);
  });
}
