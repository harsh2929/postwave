/**
 * PlanSummaryCard — the "transparent pricing / no surprises" card.
 *
 * Renders GET /api/v1/billing/plan-summary (billingApi.planSummary):
 *   - plan tier + current_period_end ("renews <date>")
 *   - per-resource usage bars (current / limit / percent, exceeded state)
 *   - an HONEST monthly-sends projection — always labelled an Estimate,
 *     never a fabricated trend. When the server says avg_per_day:0 /
 *     projected_exceed_date:null (insufficient data) we say so plainly
 *     instead of inventing a date.
 *
 * Honest-UI rules (shared with UsageSection):
 *   - every load failure renders error + Retry; nothing fabricated while
 *     a fetch is down.
 *   - a 403 here almost always means the key lacks read:reports — we
 *     translate that to a plain-language "reporting access" message
 *     rather than echoing a raw scope error.
 *   - limit <= 0 means unmetered/unlimited; we never divide by zero and
 *     never print a fake percentage for an uncapped resource.
 */

import {
  type ReactElement,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type PlanSummary,
  type PlanSummaryResource,
  billingApi,
} from "../../lib/api-client";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import { SettingsSectionHeader } from "./SettingsNav";

const SendsProjection = lazy(() =>
  import("./SendsProjection").then((module) => ({
    default: module.SendsProjection,
  })),
);

const CapabilityAvailabilityCard = lazy(() =>
  import("./CapabilityAvailabilityCard").then((module) => ({
    default: module.CapabilityAvailabilityCard,
  })),
);

/** Locale-stable thousands grouping; coerces NaN/undefined to 0. */
function fmtCount(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat("en-US").format(v);
}

/** Safe `Number.isFinite` coercion to a finite value (0 fallback). */
function finiteOrZero(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** A limit of 0 or negative means the resource is uncapped. */
function isUnlimited(limit: number | null | undefined): boolean {
  return !(typeof limit === "number" && Number.isFinite(limit) && limit > 0);
}

/** Humanize a snake_case resource key → "Monthly sends". Falls back to a
 *  title-cased version of whatever the wire sends so an unknown key still
 *  renders legibly instead of as a raw identifier. */
const RESOURCE_LABELS: Record<string, string> = {
  monthly_sends: "Monthly sends",
  sends: "Sends",
  contacts: "Contacts",
  subscribers: "Subscribers",
  lists: "Lists",
  segments: "Segments",
  campaigns: "Campaigns",
  automations: "Automations",
  api_keys: "API keys",
  team_members: "Team members",
  domains: "Sending domains",
  storage: "Storage",
};
function humanizeResource(resource: string | null | undefined): string {
  const key = (resource ?? "").trim();
  if (!key) return "Resource";
  if (RESOURCE_LABELS[key]) return RESOURCE_LABELS[key];
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Friendly tier name; tiers are studio/sending/pro on the wire. */
function humanizeTier(tier: string | null | undefined): string {
  const key = (tier ?? "").trim();
  if (!key) return "Current plan";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Clamp a percent into [0, 100] for the bar fill only — the textual
 *  percentage still shows the true (possibly >100) value so an overage
 *  reads honestly. */
function barFraction(res: PlanSummaryResource): number {
  if (isUnlimited(res.limit)) return 0;
  const current = finiteOrZero(res.current);
  const limit = finiteOrZero(res.limit);
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(1, current / limit));
}

function resourcePercent(res: PlanSummaryResource): number | null {
  if (isUnlimited(res.limit)) return null;
  const current = finiteOrZero(res.current);
  const limit = finiteOrZero(res.limit);
  if (Number.isFinite(res.percent) && res.percent >= 0) {
    return Math.round(res.percent);
  }
  return limit > 0 ? Math.round((current / limit) * 100) : null;
}

/** Format a wire ISO date as a short local date; "" if unparseable. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString();
}

export function PlanSummaryCard(): ReactElement {
  const [summary, setSummary] = useState<PlanSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [showAvailability, setShowAvailability] = useState(false);
  const activeRef = useRef(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const res = await billingApi.planSummary();
      if (!activeRef.current) return;
      if (res.error) {
        // A 403 here is almost always a missing read:reports scope — give
        // a plain-language explanation rather than the raw scope error.
        if (res.error.status === 403) {
          setErr(
            "Plan details require reporting access (read:reports) on this API key.",
          );
        } else {
          setErr(res.error.message);
        }
        setSummary(null);
        return;
      }
      setSummary(res.data ?? null);
    } catch (requestError) {
      if (!activeRef.current) return;
      setErr(
        requestError instanceof Error
          ? requestError.message
          : "Plan-summary request failed.",
      );
      setSummary(null);
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void load();
    return () => {
      activeRef.current = false;
    };
  }, [load]);

  const resources: PlanSummaryResource[] = Array.isArray(summary?.resources)
    ? (summary?.resources ?? [])
    : [];
  const renews = fmtDate(summary?.current_period_end);

  return (
    <div className="settings-section">
      <SettingsSectionHeader
        title="Your plan"
        description="What you're on, how much of each limit you've used, and an honest projection of where this month is heading. No hidden meters."
        meta={
          summary ? (
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <span className="badge accent">{humanizeTier(summary.tier)}</span>
              {renews ? (
                <span className="muted" style={{ fontSize: 12 }}>
                  renews {renews}
                </span>
              ) : null}
            </div>
          ) : null
        }
      />
      <div className="settings-section-body">
        {err ? (
          <div className="notice" role="alert">
            <span>Couldn&apos;t load plan details: {err}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div role="status" aria-label="Loading plan usage">
            <div className="skel-row" aria-hidden="true" />
            <div className="skel-row" aria-hidden="true" />
            <div className="skel-row" aria-hidden="true" />
          </div>
        ) : summary ? (
          <>
            {resources.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                {resources.map((r, idx) => (
                  <ResourceBar
                    // Resource keys *should* be unique, but a malformed
                    // wire payload could repeat one — suffix the index so
                    // React keys stay distinct regardless.
                    key={`${r.resource ?? "resource"}:${idx}`}
                    res={r}
                  />
                ))}
                <PlanResourcesData resources={resources} />
              </div>
            ) : (
              <div
                className="muted"
                style={{ fontSize: 12, marginBottom: 16 }}
                role="status"
              >
                No metered resources on this plan.
              </div>
            )}

            {summary.sends_projection ? (
              <Suspense
                fallback={
                  <div className="skel-row" role="status">
                    <span className="sr-only">Loading plan projection…</span>
                  </div>
                }
              >
                <SendsProjection projection={summary.sends_projection} />
              </Suspense>
            ) : null}
          </>
        ) : (
          <div className="muted" style={{ fontSize: 12 }} role="status">
            No plan details available.
          </div>
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ marginTop: 16 }}
          aria-expanded={showAvailability}
          aria-controls="product-availability-disclosure"
          onClick={() => setShowAvailability((visible) => !visible)}
        >
          {showAvailability ? "Hide" : "Review"} product availability
        </button>
        {showAvailability ? (
          <Suspense
            fallback={
              <p className="muted" role="status" style={{ fontSize: 12 }}>
                Loading product availability…
              </p>
            }
          >
            <CapabilityAvailabilityCard planTier={summary?.tier ?? null} />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}

function ResourceBar({ res }: { res: PlanSummaryResource }): ReactElement {
  const label = humanizeResource(res.resource);
  const current = finiteOrZero(res.current);
  const unlimited = isUnlimited(res.limit);
  const limit = finiteOrZero(res.limit);
  const fraction = barFraction(res);
  // Trust the server's percent when present & finite; otherwise derive it
  // ourselves (never divide by zero — unlimited resources show no percent).
  const percent = resourcePercent(res);
  const exceeded = Boolean(res.exceeded) || (!unlimited && current > limit);

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          fontSize: 13,
          marginBottom: 4,
        }}
      >
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span className="spacer" />
        <span className="tabular muted" style={{ fontSize: 12 }}>
          {unlimited ? (
            <>
              {fmtCount(current)} used ·{" "}
              <span style={{ fontWeight: 600 }}>unlimited</span>
            </>
          ) : (
            <>
              {fmtCount(current)} / {fmtCount(limit)}
              {percent !== null ? ` (${percent}%)` : ""}
            </>
          )}
        </span>
        {exceeded ? (
          <span className="badge danger" style={{ fontSize: 11 }}>
            Over limit
          </span>
        ) : null}
      </div>
      {unlimited ? (
        <div className="muted" style={{ fontSize: 11 }}>
          Unmetered on your plan — no cap applied.
        </div>
      ) : (
        <div
          role="progressbar"
          aria-valuenow={Math.max(0, Math.min(100, percent ?? 0))}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} usage`}
          aria-valuetext={`${fmtCount(current)} of ${fmtCount(limit)} · ${percent ?? 0}% used${exceeded ? " · over limit" : ""}`}
          style={{
            height: 8,
            borderRadius: 4,
            background:
              "color-mix(in srgb, var(--pw-fg-muted) 12%, transparent)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${(fraction * 100).toFixed(1)}%`,
              height: "100%",
              background: exceeded ? "var(--pw-danger)" : "var(--pw-accent)",
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
            }}
          />
        </div>
      )}
    </div>
  );
}

function PlanResourcesData({
  resources,
}: {
  resources: PlanSummaryResource[];
}): ReactElement {
  return (
    <AccessibleChartData
      title="Plan resource usage"
      summary={`${resources.length} metered or unmetered resources returned for the current workspace plan.`}
      rowHeaderLabel="Resource"
      columns={[
        { key: "current", label: "Current usage" },
        { key: "limit", label: "Plan limit" },
        { key: "utilization", label: "Utilization (%)" },
        { key: "status", label: "Status" },
      ]}
      rows={resources.map((resource, index) => {
        const current = finiteOrZero(resource.current);
        const unlimited = isUnlimited(resource.limit);
        const limit = finiteOrZero(resource.limit);
        const percent = resourcePercent(resource);
        const exceeded =
          Boolean(resource.exceeded) || (!unlimited && current > limit);
        return {
          key: `${resource.resource ?? "resource"}:${index}`,
          label: humanizeResource(resource.resource),
          values: {
            current: fmtCount(current),
            limit: unlimited ? "Unlimited" : fmtCount(limit),
            utilization: percent == null ? "Not applicable" : `${percent}%`,
            status: unlimited
              ? "Unmetered"
              : exceeded
                ? "Over limit"
                : "Within limit",
          },
          exportValues: {
            current,
            limit: unlimited ? "Unlimited" : limit,
            utilization: percent,
            status: unlimited
              ? "Unmetered"
              : exceeded
                ? "Over limit"
                : "Within limit",
          },
        };
      })}
      provenance={dux025Provenance("planResourceUsage")}
      exportFileName="plan-resource-usage.csv"
      exportPrivacy="confidential"
    />
  );
}
