/**
 * subscriber-insights — pure logic for the 2026-06-11 full-surface
 * wiring on the Subscribers page + detail slideover:
 *
 *   #9  Email validation  — client-side typo suggestion + batch summary
 *   #17 Lifecycle rollup  — distribution view (zero-filled, ordered)
 *   #19 Contact rating    — readable signal rows for the rating view
 *   #22 Sunset policies   — input validation + run-summary formatting
 *
 * No React, no network — everything here is unit-tested in
 * src/__tests__/components/subscriber-insights.test.ts.
 */

import type {
  EmailValidationResult,
  LifecycleDistributionRow,
  SubscriberRatingView,
} from "../../lib/api-client";
import type {
  SunsetPolicyInput,
  SunsetRunSummary,
} from "../../lib/api/sunset";

/* ---------- #9 email validation ------------------------------------ */

/**
 * Common-typo domain corrections. Deliberately conservative: only
 * domains where the typo is unambiguous get a suggestion — we never
 * "correct" a domain we don't recognize. The server-side validator has
 * no suggestion field (verified against email_validator.go), so this
 * is honest client-side assistance, surfaced as a click-to-fix hint
 * and NEVER auto-applied.
 */
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "hotmal.com": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "hotmali.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yhaoo.com": "yahoo.com",
  "outlok.com": "outlook.com",
  "outloook.com": "outlook.com",
  "outlook.co": "outlook.com",
  "iclod.com": "icloud.com",
  "icloud.co": "icloud.com",
};

/** Well-known domains a TLD-typo fix may target. Guards the `.con` →
 * `.com` style rewrites so we don't invent domains. */
const KNOWN_COM_DOMAINS = new Set([
  "gmail.com",
  "hotmail.com",
  "yahoo.com",
  "outlook.com",
  "icloud.com",
  "aol.com",
  "live.com",
  "msn.com",
  "protonmail.com",
]);

const TLD_TYPOS: Record<string, string> = {
  con: "com",
  cmo: "com",
  ocm: "com",
  vom: "com",
  comm: "com",
};

/**
 * suggestEmailFix — returns a corrected address for common domain /
 * TLD typos, or null when there's nothing (safe) to suggest. The local
 * part is preserved verbatim.
 */
export function suggestEmailFix(email: string): string | null {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase().replace(/\.$/, "");

  const direct = DOMAIN_TYPOS[domain];
  if (direct) return `${local}@${direct}`;

  // TLD typo: rewrite only when the corrected domain is one we know.
  const lastDot = domain.lastIndexOf(".");
  if (lastDot > 0) {
    const tld = domain.slice(lastDot + 1);
    const fixedTld = TLD_TYPOS[tld];
    if (fixedTld) {
      const candidate = `${domain.slice(0, lastDot)}.${fixedTld}`;
      if (KNOWN_COM_DOMAINS.has(candidate)) return `${local}@${candidate}`;
    }
  }

  // Trailing dot on an otherwise-known domain ("user@gmail.com.").
  if (trimmed.endsWith(".") && KNOWN_COM_DOMAINS.has(domain)) {
    return `${local}@${domain}`;
  }
  return null;
}

/** Human label per email_validator verdict. Unknown verdicts pass
 * through verbatim so a new server verdict is never mislabeled. */
export function verdictLabel(verdict: string): string {
  switch (verdict) {
    case "ok":
      return "Deliverable";
    case "syntax_invalid":
      return "Invalid syntax";
    case "no_mx":
      return "No mail server (MX)";
    case "disposable":
      return "Disposable domain";
    case "role_account":
      return "Role account";
    default:
      return verdict;
  }
}

export interface ValidationSummaryView {
  total: number;
  valid: number;
  invalid: number;
  /** verdict → count, insertion-ordered by first appearance. */
  byVerdict: Record<string, number>;
}

/**
 * summarizeValidationResults — client-side rollup of the per-row
 * results. The server's own summary is preferred when present; this
 * exists for the verdict breakdown the server doesn't provide.
 */
export function summarizeValidationResults(
  results: EmailValidationResult[],
): ValidationSummaryView {
  const byVerdict: Record<string, number> = {};
  let valid = 0;
  for (const r of results) {
    if (r.valid) valid++;
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  }
  return {
    total: results.length,
    valid,
    invalid: results.length - valid,
    byVerdict,
  };
}

/* ---------- #17 lifecycle distribution ----------------------------- */

export interface LifecycleStageView {
  stage: string;
  count: number;
  /** 0..100 share of the total; 0 when the total is 0. */
  pct: number;
}

export interface LifecycleDistributionView {
  rows: LifecycleStageView[];
  total: number;
}

/**
 * buildLifecycleView — merges the distribution histogram with the
 * stage catalog: stages with no subscribers render as zero rows (in
 * catalog order), and any distribution stage missing from the catalog
 * is appended rather than dropped — the card must account for every
 * subscriber the server counted.
 */
export function buildLifecycleView(
  items: LifecycleDistributionRow[],
  stages: string[],
): LifecycleDistributionView {
  const counts = new Map<string, number>();
  for (const row of items) {
    counts.set(row.stage, (counts.get(row.stage) ?? 0) + row.count);
  }
  const ordered: string[] = [...stages];
  for (const row of items) {
    if (!ordered.includes(row.stage)) ordered.push(row.stage);
  }
  const total = items.reduce((sum, r) => sum + r.count, 0);
  const rows = ordered.map((stage) => {
    const count = counts.get(stage) ?? 0;
    return {
      stage,
      count,
      pct: total > 0 ? (count / total) * 100 : 0,
    };
  });
  return { rows, total };
}

/* ---------- #19 contact rating signals ------------------------------ */

export interface RatingSignalRow {
  label: string;
  value: string;
}

export function ratingSourceLabel(source: string): string {
  switch (source) {
    case "manual":
      return "Manual — set by an operator; recompute never overwrites it";
    case "heuristic":
      return "Heuristic — derived from the engagement score";
    default:
      return source;
  }
}

/**
 * ratingSignalRows — the readable breakdown of everything the
 * contact-ratings GET actually returns (subscriber_id, stars,
 * engagement_score, engagement_score_at, source). The wire carries no
 * per-signal map (verified against contact_rating/rating.go), so this
 * renders the real fields instead of inventing one.
 */
export function ratingSignalRows(view: SubscriberRatingView): RatingSignalRow[] {
  const rows: RatingSignalRow[] = [];
  rows.push({
    label: "Stars",
    value: view.stars != null ? `${view.stars}/5` : "Unrated",
  });
  rows.push({
    label: "Engagement score",
    value:
      view.engagement_score != null
        ? `${view.engagement_score}/100`
        : "No engagement signal yet",
  });
  if (view.engagement_score_at) {
    rows.push({ label: "Score computed", value: view.engagement_score_at });
  }
  rows.push({ label: "Source", value: ratingSourceLabel(view.source) });
  return rows;
}

/* ---------- #22 sunset policies ------------------------------------- */

export const SUNSET_ACTIONS = ["suppress", "tag", "winback"] as const;

export const SUNSET_ACTION_LABELS: Record<string, string> = {
  suppress: "Suppress (stop all sends)",
  tag: "Tag for review",
  winback: "Queue win-back email",
};

/** Server-enforced bounds (sunset handlers validate 30..730). */
export const SUNSET_INACTIVE_DAYS_MIN = 30;
export const SUNSET_INACTIVE_DAYS_MAX = 730;

/** Comma-separated tag input → trimmed, deduped list. */
export function parseExcludedTags(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(",")) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * validateSunsetPolicyInput — mirrors the server-side checks so the
 * form can fail fast with field-level errors. Returns {} when valid.
 */
export function validateSunsetPolicyInput(
  input: SunsetPolicyInput,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.name.trim()) {
    errors["name"] = "Name is required.";
  }
  if (
    !Number.isFinite(input.inactiveDays) ||
    !Number.isInteger(input.inactiveDays) ||
    input.inactiveDays < SUNSET_INACTIVE_DAYS_MIN ||
    input.inactiveDays > SUNSET_INACTIVE_DAYS_MAX
  ) {
    errors["inactiveDays"] =
      `Inactive days must be a whole number between ${SUNSET_INACTIVE_DAYS_MIN} and ${SUNSET_INACTIVE_DAYS_MAX}.`;
  }
  if (!(SUNSET_ACTIONS as readonly string[]).includes(input.action)) {
    errors["action"] = "Pick a sunset action.";
  }
  return errors;
}

/** One-line criteria description for a policy row. */
export function describeSunsetCriteria(policy: {
  inactiveDays: number;
  action: string;
  excludedTags: string[];
}): string {
  const action = SUNSET_ACTION_LABELS[policy.action] ?? policy.action;
  const excl =
    policy.excludedTags.length > 0
      ? ` · excludes ${policy.excludedTags.join(", ")}`
      : "";
  return `Inactive ≥ ${policy.inactiveDays} days → ${action}${excl}`;
}

/**
 * summarizeSunsetRun — formats a run summary VERBATIM from the server
 * payload. No counts are invented: zero candidates reads as zero, which can
 * mean no enabled subscribers currently qualify or prior executions already
 * made this policy idempotent for them.
 */
export function summarizeSunsetRun(summary: SunsetRunSummary): string {
  const actions = Object.entries(summary.byAction ?? {})
    .map(([action, n]) => `${action}: ${n.toLocaleString()}`)
    .join(" · ");
  const base = `${summary.candidatesSeen.toLocaleString()} candidate${
    summary.candidatesSeen === 1 ? "" : "s"
  } seen`;
  const errs =
    summary.errors && summary.errors.length > 0
      ? ` · ${summary.errors.length} error${summary.errors.length === 1 ? "" : "s"}`
      : "";
  return actions ? `${base} · ${actions}${errs}` : `${base}${errs}`;
}
