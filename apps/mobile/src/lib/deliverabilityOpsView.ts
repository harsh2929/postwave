/**
 * deliverabilityOpsView — pure decision/copy helpers for the recovery and
 * evidence cards added in the 2026-08 desktop-parity pass.
 *
 * Imports nothing from react-native, so it runs under the node vitest project.
 * Anything here that produced a sentence was written to match desktop's
 * meaning (not its markup): the two clients must never disagree about whether
 * a signal is fine.
 */
import type {
  AuthCheckRow,
  EqScoreResult,
  EqSubScore,
} from "@/api/deliverabilityEvidence";
import type { RetryEvent } from "@/api/deliverabilityRecovery";
import type { WebhookErrorsReport } from "@/api/deliverabilityHubOps";
import type { SignalTone } from "./deliverabilitySignals";
import { num, plural } from "./format";

/* ------------------------------------------------------- webhook errors --- */

/**
 * The one-line verdict. Zero failures is a REAL all-clear (the endpoint
 * answered), which is different from "could not check" — the caller renders
 * that difference with `unavailableReason`.
 */
export function webhookErrorsCaption(report: WebhookErrorsReport): string {
  const failures = report.items.length;
  const broken = report.failedVerifications.length;
  if (failures === 0 && broken === 0) {
    return "Event webhooks delivered and DNS verifications passed in the last 7 days.";
  }
  const parts: string[] = [];
  if (failures > 0) {
    parts.push(
      `${plural(failures, "failed webhook delivery", "failed webhook deliveries")}`,
    );
  }
  if (broken > 0)
    parts.push(
      `${plural(broken, "unverified identity", "unverified identities")}`,
    );
  return `${parts.join(" · ")} in the last 7 days.`;
}

/* ---------------------------------------------------- intelligent retry --- */

/** `pending` is the exact cooling-window state; this is not an action policy. */
export function retryEventIsHeld(event: Pick<RetryEvent, "status">): boolean {
  return event.status === "pending";
}

export interface RetryEventActionPolicy {
  markReady: boolean;
  dismiss: boolean;
}

/** Mirror retryTransitionAllowed without accepting undocumented aliases. */
export function retryEventActionPolicy(
  event: Pick<RetryEvent, "status">,
): RetryEventActionPolicy {
  if (event.status === "pending" || event.status === "failed") {
    return { markReady: true, dismiss: true };
  }
  if (event.status === "ready") {
    return { markReady: false, dismiss: true };
  }
  return { markReady: false, dismiss: false };
}

export function retryQueueCaption(events: readonly RetryEvent[]): string {
  if (events.length === 0) return "No retry queue record is available.";
  const pending = events.filter(retryEventIsHeld).length;
  const failed = events.filter((event) => event.status === "failed").length;
  const ready = events.filter((event) => event.status === "ready").length;
  const parts: string[] = [];
  if (pending > 0) parts.push(`${plural(pending, "send")} cooling`);
  if (failed > 0) parts.push(`${plural(failed, "send")} failed`);
  if (ready > 0) parts.push(`${plural(ready, "send")} ready`);
  const historical = events.length - pending - failed - ready;
  if (historical > 0) {
    parts.push(plural(historical, "historical record"));
  }
  return `${parts.join(" · ")}.`;
}

/* --------------------------------------------------------- auth checks --- */

export type AuthStatus = "ok" | "warn" | "fail" | "unknown";

export function authStatus(raw: string): AuthStatus {
  const value = raw.trim().toLowerCase();
  if (value === "ok" || value === "pass") return "ok";
  if (value === "warn" || value === "warning") return "warn";
  if (value === "fail" || value === "error") return "fail";
  return "unknown";
}

export function authStatusTone(status: AuthStatus): SignalTone {
  if (status === "ok") return "success";
  if (status === "warn") return "warning";
  if (status === "fail") return "danger";
  return "neutral";
}

/** The row's rollup: the worst of its five checks, unknown counting as warn-ish. */
export function authWorstStatus(row: AuthCheckRow): AuthStatus {
  const rank: Record<AuthStatus, number> = {
    fail: 0,
    warn: 1,
    unknown: 2,
    ok: 3,
  };
  let worst: AuthStatus = "ok";
  for (const cell of Object.values(row.checks)) {
    const status = authStatus(cell.status);
    if (rank[status] < rank[worst]) worst = status;
  }
  return worst;
}

/* ---------------------------------------------------- placement report --- */

const PLACEMENT_LABELS: Record<string, string> = {
  primary: "Primary",
  inbox: "Inbox",
  promotions: "Promotions",
  updates: "Updates",
  spam: "Spam",
  missing: "Missing",
};

export function placementLabel(code: string): string {
  const key = code.trim().toLowerCase();
  if (PLACEMENT_LABELS[key]) return PLACEMENT_LABELS[key];
  const cleaned = key.replace(/_/g, " ");
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "—";
}

export interface PlacementRow {
  code: string;
  label: string;
  /** Fraction 0..1, exactly as the server sent it. */
  fraction: number;
}

/**
 * Inbox-like placements first, spam last, so the stacked bar reads
 * best-to-worst left to right; within a band, larger share first.
 */
export function placementRows(
  overallPct: Record<string, number>,
): PlacementRow[] {
  const bandOf = (code: string): number => {
    const key = code.trim().toLowerCase();
    if (key === "primary" || key === "inbox") return 0;
    if (key === "spam" || key === "missing") return 2;
    return 1;
  };
  return Object.entries(overallPct)
    .filter(([, fraction]) => Number.isFinite(fraction) && fraction > 0)
    .map(([code, fraction]) => ({
      code,
      label: placementLabel(code),
      fraction,
    }))
    .sort((a, b) => {
      const band = bandOf(a.code) - bandOf(b.code);
      if (band !== 0) return band;
      return b.fraction - a.fraction;
    });
}

export function placementTone(code: string): SignalTone {
  const key = code.trim().toLowerCase();
  if (key === "primary" || key === "inbox") return "success";
  if (key === "spam" || key === "missing") return "danger";
  return "warning";
}

/* ------------------------------------------------------------ eq score --- */

export interface EqPillarRow {
  key: "content" | "auth" | "reputation";
  label: string;
  /** Null when the server skipped the pillar — "not scored", never a fake 0. */
  score: number | null;
  reasons: string[];
}

export function eqPillarRows(result: EqScoreResult): EqPillarRow[] {
  const skipped = new Set(
    result.skippedSubScores.map((entry) => entry.trim().toLowerCase()),
  );
  const row = (
    key: EqPillarRow["key"],
    label: string,
    pillar: EqSubScore,
  ): EqPillarRow => ({
    key,
    label,
    score: skipped.has(key) ? null : pillar.score,
    reasons: pillar.reasons.map((reason) => reason.message),
  });
  return [
    row("content", "Content", result.content),
    row("auth", "Authentication", result.auth),
    row("reputation", "Reputation", result.reputation),
  ];
}

/* ------------------------------------------------------------ bot opens --- */

/**
 * "41% of opens were machines (12,040 of 29,360)". Zero total opens is not a
 * 0% machine share — there is nothing to have a share OF, so say that.
 */
export function botOpenShareCaption(stats: {
  totalOpens: number;
  botOpens: number;
}): string {
  if (stats.totalOpens <= 0) return "No opens recorded in this window yet.";
  const pct = Math.round((stats.botOpens / stats.totalOpens) * 100);
  return `${pct}% of opens were machines (${num(stats.botOpens)} of ${num(stats.totalOpens)}).`;
}

/* ------------------------------------------------- provider connections --- */

/**
 * What the redacted GET tells us about a connection's stored secrets. The
 * server masks values, so presence is the ONLY honest claim: a token hash key
 * means a webhook token was stored; `credential_ref` is a runtime-secret NAME
 * (not a secret), stored verbatim or masked — either way it is "set".
 */
export function providerSecretSummary(
  config: Record<string, unknown> | undefined,
): string {
  const c = config ?? {};
  const parts: string[] = [];
  if ("webhook_token_hash" in c || "webhook_token" in c || "token" in c) {
    parts.push("webhook token set");
  }
  const ref =
    typeof c.credential_ref === "string" ? c.credential_ref.trim() : "";
  if (ref) parts.push("vault reference set");
  return parts.length > 0 ? parts.join(" · ") : "no secrets stored";
}

/** Mirror of the server's webhook-token rule (32–512 printable, no spaces). */
export function providerTokenError(token: string): string | null {
  const value = token.trim();
  if (!value) return null;
  if (value.length < 32) return "Webhook tokens are at least 32 characters.";
  if (value.length > 512) return "Webhook tokens are at most 512 characters.";
  if (/\s/.test(value)) return "Webhook tokens cannot contain whitespace.";
  return null;
}

/**
 * A credential reference is a runtime-secret NAME. Anything that looks like
 * pasted credential material (whitespace, very long) is refused client-side
 * with the same intent as the server's rule.
 */
export function providerCredentialRefError(ref: string): string | null {
  const value = ref.trim();
  if (!value) return null;
  if (/\s/.test(value)) return "A vault reference is a name — no spaces.";
  if (value.length > 256)
    return "That looks like credential material, not a reference name.";
  return null;
}

/** The 8 providers the server accepts (normalizeProviderName). */
export const DELIVERABILITY_PROVIDERS = [
  "postmark",
  "mailgun",
  "ses",
  "sendgrid",
  "resend",
  "sparkpost",
  "mailersend",
  "mailchimp",
] as const;

/* ----------------------------------------------------- warm-up create --- */

export interface WarmupDraft {
  domain: string;
  targetDaily: string;
  days: string;
}

/** Null when submittable; otherwise the reason the form refuses. */
export function warmupDraftError(draft: WarmupDraft): string | null {
  const domain = draft.domain.trim().toLowerCase();
  if (!domain) return "Enter the domain to warm up.";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return "That doesn't look like a domain.";
  }
  const target = Number(draft.targetDaily.trim());
  if (!Number.isFinite(target) || target < 1) {
    return "Target daily volume must be at least 1.";
  }
  const daysRaw = draft.days.trim();
  if (daysRaw !== "") {
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return "Ramp length must be 1–365 days.";
    }
  }
  return null;
}

/* ------------------------------------------------- diagnosis sections --- */

export interface DiagnosisSection {
  heading: string;
  body: string;
}

/**
 * The diagnosis arrives as markdown. Phones don't render markdown here; split
 * it into heading/body pairs so each section becomes a titled block. Text
 * before the first heading becomes an untitled lead section.
 */
export function splitDiagnosisSections(markdown: string): DiagnosisSection[] {
  const out: DiagnosisSection[] = [];
  let heading = "";
  let lines: string[] = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    if (heading || body) out.push({ heading, body });
    lines = [];
  };
  for (const line of markdown.split("\n")) {
    const match = /^#{1,4}\s+(.*)$/.exec(line.trim());
    if (match) {
      flush();
      heading = (match[1] ?? "").trim();
    } else {
      lines.push(line);
    }
  }
  flush();
  return out;
}

/* -------------------------------------------------- verification meter --- */

/**
 * One sentence for the credit meter. A null balance is "unmetered or
 * unknown" — never rendered as zero, which would read as "out of credits".
 */
export function verificationCreditsCaption(credits: {
  provider: string;
  balance: number | null;
  totals: { creditsSpent: number; creditsSaved: number };
}): string {
  if (!credits.provider) {
    return "No paid verification provider is configured — the free local tier is doing the filtering.";
  }
  const spentSaved = `${num(credits.totals.creditsSpent)} credits spent · ${num(credits.totals.creditsSaved)} saved by the local tier`;
  if (credits.balance === null) {
    return `${credits.provider}: balance not reported. ${spentSaved}.`;
  }
  return `${credits.provider}: ${num(credits.balance)} credits left. ${spentSaved}.`;
}

/* ------------------------------------------------- reputation sparkline --- */

export interface SparkBar {
  /** 0..1 height share; a zero-score day still gets a visible sliver. */
  height: number;
  tone: SignalTone;
}

export function reputationSparkBars(
  points: readonly { score: number }[],
): SparkBar[] {
  return points.map((point) => {
    const score = Math.max(0, Math.min(100, point.score));
    return {
      height: Math.max(0.06, score / 100),
      tone: score >= 80 ? "success" : score >= 60 ? "warning" : "danger",
    };
  });
}
