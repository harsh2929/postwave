/**
 * InboxProviderHealthCard — per-domain (Gmail / Yahoo / Outlook / iCloud /
 * Other) audience + suppression split.
 *
 * Why this exists: post-Feb 2024 Gmail/Yahoo sender requirements made
 * per-domain reputation a hard pass/fail. Seeing where your audience and
 * your suppressions concentrate per provider surfaces an imbalance early.
 *
 * Data strategy — what's possible CLIENT-SIDE today:
 *
 *   - Subscriber list → bucketed by `@` to get the audience split per
 *     provider (from the most recent rows fetched).
 *   - Suppressions list (reason=hard_bounce, reason=complaint) → bucketed
 *     by `@` to get per-provider suppression COUNTS.
 *
 * What's intentionally NOT shown:
 *
 *   - Per-provider bounce/complaint RATES. Both source lists are capped
 *     at 500 rows and cover disjoint populations (current subscribers vs
 *     all-time suppressions), so dividing one by the other produces
 *     numbers that look like compliance metrics but aren't. Real rates
 *     (against actual send volume) live in the Deliverability Hub.
 *   - Per-domain open rate. The campaign report aggregates open events
 *     in totals only; there's no recipient-keyed open feed in the API.
 */

import { type ReactElement, useMemo, useRef } from "react";

import { api, suppressionsApi } from "../../lib/api-client";
import type { Subscriber, SuppressionRow } from "../../lib/api-client";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import { setSection } from "../../lib/store";
import { InlineHelp } from "../InlineHelp";

/* ---------- domain bucketing ---------------------------------------- */

type ProviderKey = "gmail" | "yahoo" | "outlook" | "icloud" | "other";

interface ProviderDef {
  key: ProviderKey;
  label: string;
  /** Lowercase exact-match domains rolled into this bucket. */
  domains: ReadonlyArray<string>;
}

/**
 * Provider buckets. Ordering matters — we render rows in this sequence so
 * the post-Feb-2024 "life or death" providers (Gmail, Yahoo) lead the card.
 * `outlook` covers the post-2013 microsoft.com mail consolidation —
 * outlook.com / hotmail.com / live.com / msn.com all land on the same
 * Microsoft pipeline.
 */
const PROVIDERS: ReadonlyArray<ProviderDef> = [
  { key: "gmail", label: "Gmail", domains: ["gmail.com", "googlemail.com"] },
  {
    key: "yahoo",
    label: "Yahoo",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk"],
  },
  {
    key: "outlook",
    label: "Outlook / Microsoft",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
  },
  {
    key: "icloud",
    label: "iCloud",
    domains: ["icloud.com", "me.com", "mac.com"],
  },
  { key: "other", label: "Other", domains: [] },
];

/**
 * Map raw `name@host.tld` strings to their provider bucket. Lowercases
 * the host, strips obvious whitespace, and routes anything we don't
 * recognise into "other" so the bucket totals up to the full audience.
 *
 * Returns null for malformed inputs (empty / no `@` / no host) — we
 * skip those rather than guess; deliverability math built on noise
 * is worse than no math at all.
 */
function bucketEmail(email: string): ProviderKey | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const host = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!host) return null;
  for (const p of PROVIDERS) {
    if (p.domains.includes(host)) return p.key;
  }
  return "other";
}

interface ProviderRow {
  key: ProviderKey;
  label: string;
  /** Subscribers we observed in this bucket. */
  audience: number;
  /** Suppressions tagged as `hard_bounce` in this bucket. */
  bounces: number;
  /** Suppressions tagged as `complaint` in this bucket. */
  complaints: number;
}

function emptyRow(p: ProviderDef): ProviderRow {
  return {
    key: p.key,
    label: p.label,
    audience: 0,
    bounces: 0,
    complaints: 0,
  };
}

function fmtCount(n: number): string {
  if (n >= 1000) return n.toLocaleString();
  return String(n);
}

/* ---------- card ----------------------------------------------------- */

interface Props {
  /**
   * Accepted for call-site compatibility but intentionally NOT rendered:
   * the underlying subscriber/suppression fetches ignore the page's date
   * range, so labelling this card with the range window would misstate
   * what the numbers cover.
   */
  windowLabel?: string;
}

interface ProviderSourceData {
  subscribers: Subscriber[];
  bounceSuppressions: SuppressionRow[];
  complaintSuppressions: SuppressionRow[];
}

export function InboxProviderHealthCard(_props: Props): ReactElement {
  const retryFlightRef = useRef<Promise<void> | null>(null);
  const source = useRemoteResource<ProviderSourceData>(
    async () => {
      const [subscribers, bounces, complaints] = await Promise.all([
        Promise.resolve().then(() => api.listSubscribers({ perPage: 500 })),
        Promise.resolve().then(() =>
          suppressionsApi.list({ reason: "hard_bounce", perPage: 500 }),
        ),
        Promise.resolve().then(() =>
          suppressionsApi.list({ reason: "complaint", perPage: 500 }),
        ),
      ]);
      const firstError = subscribers.error ?? bounces.error ?? complaints.error;
      if (firstError) return { error: firstError };
      return {
        data: {
          subscribers:
            subscribers.data?.items ??
            subscribers.data?.data ??
            subscribers.data?.results ??
            [],
          bounceSuppressions:
            bounces.data?.items ??
            bounces.data?.data ??
            bounces.data?.results ??
            [],
          complaintSuppressions:
            complaints.data?.items ??
            complaints.data?.data ??
            complaints.data?.results ??
            [],
        },
      };
    },
    { identity: "inbox-provider-health" },
  );
  const subscribers = source.data?.subscribers ?? null;
  const bounceSupps = source.data?.bounceSuppressions ?? null;
  const complaintSupps = source.data?.complaintSuppressions ?? null;
  const loading = source.transport === "loading";
  const retry = (): void => {
    if (retryFlightRef.current) return;
    const request = source.reload();
    retryFlightRef.current = request;
    void request.finally(() => {
      if (retryFlightRef.current === request) retryFlightRef.current = null;
    });
  };

  /* Bucket the three lists once whenever any source list changes. The
   * "rows" array is what the render iterates over — we keep providers
   * in their declared order so Gmail / Yahoo always lead. */
  const rows = useMemo<ProviderRow[]>(() => {
    const out = new Map<ProviderKey, ProviderRow>(
      PROVIDERS.map((p) => [p.key, emptyRow(p)]),
    );
    const tally = (
      list: ReadonlyArray<{ email: string }> | null,
      field: "audience" | "bounces" | "complaints",
    ): void => {
      if (!list) return;
      for (const r of list) {
        const k = bucketEmail(r.email);
        if (!k) continue;
        const row = out.get(k);
        if (!row) continue;
        row[field] += 1;
      }
    };
    tally(subscribers, "audience");
    tally(bounceSupps, "bounces");
    tally(complaintSupps, "complaints");
    return PROVIDERS.map((p) => out.get(p.key) ?? emptyRow(p));
  }, [subscribers, bounceSupps, complaintSupps]);

  /* Render only the top-5 by audience to avoid a long "Other" row
   * dominating when most providers fall outside the named buckets.
   * PROVIDERS already has 5 entries, but the ordering must be by
   * audience-desc for the user — Gmail/Yahoo lead anyway because they
   * dominate most workspaces, but a B2B-heavy tenant might surface
   * Outlook first, which is the honest answer. */
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => b.audience - a.audience);
    return copy.slice(0, 5);
  }, [rows]);

  const totalAudience = useMemo(
    () => rows.reduce((s, r) => s + r.audience, 0),
    [rows],
  );

  return (
    <div className="card pw-chart-card">
      <div className="pw-chart-head">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Inbox provider split
          <InlineHelp
            text={
              "Per-domain split of your subscriber base plus per-provider " +
              "suppression counts (hard bounces and complaints) from the most " +
              "recent rows fetched. These are counts over a sample, not rates — " +
              "open the Deliverability Hub for real per-send bounce and " +
              "complaint rates."
            }
          />
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setSection("deliverabilityHub")}
        >
          Open Deliverability Hub →
        </button>
      </div>

      {source.failure ? (
        <div className="notice" role="alert">
          <span>
            Couldn&apos;t verify the provider split: {source.failure.message}
            {source.stale
              ? " The last verified sample remains visible below."
              : ""}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={loading || undefined}
            aria-busy={loading || undefined}
            onClick={() => {
              if (!loading) retry();
            }}
          >
            {loading ? "Retrying…" : "Retry provider split"}
          </button>
        </div>
      ) : null}
      {source.data === null && loading ? (
        <div className="pw-chart-empty" role="status">
          Computing per-domain split…
        </div>
      ) : source.data === null ? (
        <div className="pw-chart-empty">
          No verified provider sample is available. Retry when the service is
          reachable.
        </div>
      ) : totalAudience === 0 ? (
        <div className="pw-chart-empty">
          No subscribers yet — add some to see provider distribution.
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table className="data-table" style={{ width: "100%" }}>
              <caption className="visually-hidden">
                Inbox provider audience and suppression sample
              </caption>
              <thead>
                <tr>
                  <th scope="col">Provider and sampled audience</th>
                  <th scope="col">
                    Open rate
                    <InlineHelp text="Per-domain open rate is unavailable because the product does not yet receive recipient-keyed open events." />
                  </th>
                  <th scope="col">
                    Hard bounces
                    <InlineHelp text="Hard-bounce suppressions in the most recent rows fetched, up to 500. This is a sampled count, not a rate." />
                  </th>
                  <th scope="col">
                    Complaints
                    <InlineHelp text="Complaint suppressions in the most recent rows fetched, up to 500. This is a sampled count, not a rate." />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const audiencePct =
                    totalAudience > 0
                      ? (row.audience / totalAudience) * 100
                      : 0;
                  return (
                    <tr key={row.key}>
                      <th scope="row">
                        <span
                          style={{ color: "var(--pw-fg)", fontWeight: 500 }}
                        >
                          {row.label}
                        </span>
                        <span
                          className="muted tabular"
                          style={{
                            display: "block",
                            fontSize: 10,
                            marginTop: 2,
                          }}
                        >
                          {fmtCount(row.audience)} subscriber
                          {row.audience === 1 ? "" : "s"} ·{" "}
                          {audiencePct.toFixed(1)}% of sampled audience
                        </span>
                      </th>
                      <td className="muted">
                        Not available
                        <span style={{ display: "block", fontSize: 10 }}>
                          Recipient-keyed feed not available
                        </span>
                      </td>
                      <td className="tabular">
                        {fmtCount(row.bounces)}
                        <span
                          className="muted"
                          style={{ display: "block", fontSize: 10 }}
                        >
                          sampled hard-bounce suppressions
                        </span>
                      </td>
                      <td className="tabular">
                        {fmtCount(row.complaints)}
                        <span
                          className="muted"
                          style={{ display: "block", fontSize: 10 }}
                        >
                          sampled complaint suppressions
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            className="muted"
            style={{ fontSize: 10, marginTop: 8, lineHeight: 1.5 }}
          >
            Counts come from the most recent subscriber + suppression rows
            fetched (up to 500 each) and ignore the page&apos;s date range —
            they are not rates. For real per-provider bounce / complaint rates
            against send volume, use the Deliverability Hub.
          </div>
        </>
      )}
    </div>
  );
}
