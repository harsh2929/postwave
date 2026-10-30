/**
 * lib/billingNormalize.ts — the arithmetic and copy behind the Plan & usage
 * screen, kept pure so it can be unit-tested without React Native.
 *
 * Three problems this exists to solve, all found in the maturity audit:
 *
 *  1. CRASH ON A PARTIAL PAYLOAD. `app/(tabs)/billing.tsx` read
 *     `summary.resources.length` and mapped it directly. An older gateway (or
 *     any response that omits the field) turned the plan screen into a
 *     TypeError, and a row with a missing `percent` produced `width: "NaN%"`.
 *     `normalizePlanSummary` coerces the shape and RE-DERIVES percent from
 *     current/limit — the same fallback desktop's PlanSummaryCard uses
 *     (barFraction / resourcePercent → finiteOrZero).
 *
 *  2. A PROJECTION THE ENDPOINT ALREADY RETURNS AND MOBILE DROPPED.
 *     GET /api/v1/billing/plan-summary attaches `sends_projection` for the
 *     monthly_sends row (apps/api/internal/limits/plan_summary.go). It is an
 *     honest linear extrapolation and it carries its OWN insufficient-data
 *     signal: `avg_per_day === 0` means "we cannot project", and
 *     `projected_exceed_date` is null when no exceedance is projected. We
 *     never invent a date the server declined to give.
 *
 *  3. AN OPEN REDIRECT WAITING TO HAPPEN. The Stripe portal endpoint returns a
 *     URL that we then hand to `Linking.openURL`. `safeBillingRedirectURL`
 *     ports the web app's allow-list so a compromised or misconfigured
 *     response cannot open an arbitrary scheme (`javascript:`, a custom app
 *     scheme) or an unrelated host from inside the app.
 */
import { date, num } from "./format";

export interface PlanUsageRow {
  resource: string;
  current: number;
  limit: number;
  percent: number;
  exceeded: boolean;
}

export interface SendsProjection {
  current: number;
  limit: number;
  avg_per_day: number;
  days_elapsed: number;
  days_in_period: number;
  projected_end_of_period: number;
  projected_exceed_date: string | null;
  on_track_to_exceed: boolean;
}

export interface PlanSummary {
  tier: string;
  current_period_end?: string | undefined;
  resources: PlanUsageRow[];
  sends_projection?: SendsProjection | undefined;
}

function finiteOrZero(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Percent for one usage row, clamped to 0–100.
 *
 * The server's `percent` is authoritative when it is a usable number. When it
 * is absent/NaN we recompute from current/limit; an unlimited row (limit <= 0)
 * is 0 rather than Infinity, because "unlimited" is not "100% full".
 */
export function resourcePercent(row: {
  current?: unknown;
  limit?: unknown;
  percent?: unknown;
}): number {
  const raw = typeof row.percent === "number" ? row.percent : Number(row.percent);
  const limit = finiteOrZero(row.limit);
  const current = finiteOrZero(row.current);
  const derived =
    Number.isFinite(raw) && raw >= 0 ? raw : limit > 0 ? (current / limit) * 100 : 0;
  if (!Number.isFinite(derived)) return 0;
  return Math.max(0, Math.min(100, derived));
}

function normalizeSendsProjection(value: unknown): SendsProjection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = asRecord(value);
  const exceedDate =
    typeof p.projected_exceed_date === "string" && p.projected_exceed_date.trim()
      ? p.projected_exceed_date
      : null;
  return {
    current: finiteOrZero(p.current),
    limit: finiteOrZero(p.limit),
    avg_per_day: finiteOrZero(p.avg_per_day),
    days_elapsed: finiteOrZero(p.days_elapsed),
    days_in_period: finiteOrZero(p.days_in_period),
    projected_end_of_period: finiteOrZero(p.projected_end_of_period),
    projected_exceed_date: exceedDate,
    on_track_to_exceed: p.on_track_to_exceed === true,
  };
}

/** Coerce an arbitrary plan-summary payload into something safe to render. */
export function normalizePlanSummary(raw: unknown): PlanSummary {
  const src = asRecord(raw);
  const rawRows = Array.isArray(src.resources) ? src.resources : [];
  const resources: PlanUsageRow[] = [];
  for (const entry of rawRows) {
    const row = asRecord(entry);
    const resource = typeof row.resource === "string" ? row.resource : "";
    if (!resource) continue;
    const limit = finiteOrZero(row.limit);
    const current = finiteOrZero(row.current);
    const percent = resourcePercent(row);
    resources.push({
      resource,
      current,
      limit,
      percent,
      // Trust the server's verdict when it sent one; otherwise derive it.
      exceeded:
        typeof row.exceeded === "boolean"
          ? row.exceeded
          : limit > 0 && current > limit,
    });
  }
  const projection = normalizeSendsProjection(src.sends_projection);
  return {
    tier: typeof src.tier === "string" ? src.tier : "",
    ...(typeof src.current_period_end === "string"
      ? { current_period_end: src.current_period_end }
      : {}),
    resources,
    ...(projection ? { sends_projection: projection } : {}),
  };
}

/** Human label for a usage-row resource key ("monthly_sends" → "Monthly sends"). */
export function usageResourceLabel(resource: string): string {
  const spaced = resource.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type ProjectionTone = "warning" | "neutral";

export interface ProjectionCopy {
  tone: ProjectionTone;
  /** Complete sentence rendered under the monthly-sends bar. */
  text: string;
  /** ISO date the server projects the cap is crossed, when it gave one. */
  exceedDate: string | null;
}

/**
 * Turn a `sends_projection` into one honest sentence, or null when there is
 * no projection at all. The insufficient-data guard mirrors
 * `limits.ComputeSendsProjection`: with `avg_per_day === 0` no trend exists,
 * so we say so instead of extrapolating from nothing, and we never render a
 * date the server declined to give.
 */
export function projectionCopy(
  projection: SendsProjection | undefined,
): ProjectionCopy | null {
  if (!projection) return null;
  if (projection.avg_per_day <= 0 || projection.days_elapsed <= 0) {
    return {
      tone: "neutral",
      text: "Not enough sending yet this period to project a total.",
      exceedDate: null,
    };
  }
  const projected = num(projection.projected_end_of_period);
  if (projection.on_track_to_exceed) {
    const when = projection.projected_exceed_date;
    return {
      tone: "warning",
      text: when
        ? `On pace to pass the send cap around ${date(when)} — about ${projected} sends by the end of the period (estimate).`
        : `On pace to pass the send cap this period — about ${projected} sends (estimate).`,
      exceedDate: when,
    };
  }
  return {
    tone: "neutral",
    text: `On pace for about ${projected} sends this period (estimate).`,
    exceedDate: null,
  };
}

/**
 * A spoken sentence for one usage bar, so VoiceOver reads a single coherent
 * statement instead of four detached numbers.
 */
export function usageBarSpoken(row: PlanUsageRow): string {
  const label = usageResourceLabel(row.resource);
  if (row.limit <= 0) {
    return `${label}: ${num(row.current)} used, unlimited.`;
  }
  const over = row.exceeded ? " Over the plan limit." : "";
  return `${label}: ${num(row.current)} of ${num(row.limit)} used, ${Math.round(
    row.percent,
  )} percent.${over}`;
}

/**
 * Hosts we will hand to `Linking.openURL` for a billing redirect. Ported from
 * apps/web/src/lib/safe-navigation.ts — the server response is trusted for its
 * CONTENT, never for where it points.
 */
const BILLING_HOST_ALLOWLIST = [
  "stripe.com",
  "billing.stripe.com",
  "checkout.stripe.com",
];

function hostMatches(host: string, allowed: string): boolean {
  return host === allowed || host.endsWith(`.${allowed}`);
}

/**
 * Validate a billing/invoice URL before opening it.
 *
 * Accepts https:// URLs on a Stripe host, or on the same host as the
 * workspace's own API base (the local/dev portal fallback at
 * apps/api/internal/billing/portal.go returns exactly that). Everything else
 * — including http://, javascript:, and unrelated hosts — returns null.
 */
export function safeBillingRedirectURL(
  candidate: unknown,
  baseUrl?: string | null,
): string | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (BILLING_HOST_ALLOWLIST.some((allowed) => hostMatches(host, allowed))) {
    return parsed.toString();
  }
  if (baseUrl) {
    try {
      const base = new URL(baseUrl);
      if (base.hostname.toLowerCase() === host) return parsed.toString();
    } catch {
      return null;
    }
  }
  return null;
}
