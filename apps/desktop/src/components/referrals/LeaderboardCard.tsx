/**
 * LeaderboardCard — ranked referrer overview for the Referrals page
 * (GET /api/v1/referrals/leaderboard, roadmap R12).
 *
 * Window chips re-query the server (30/90/365 days); rank + masked
 * email + window conversions + all-time milestone tier render verbatim
 * from the wire. Emails are pre-masked server-side — this card is an
 * operator overview, not a PII drill-down.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type ReferralLeaderboardResponse,
  referralsLeaderboardApi,
} from "../../lib/api-client";
import { decodeReferralLeaderboard } from "../../lib/referral-contracts";
import { SectionHeader } from "../SectionHeader";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import {
  LEADERBOARD_DEFAULT_WINDOW,
  LEADERBOARD_LIMIT,
  LEADERBOARD_WINDOWS,
  leaderboardEmptyCopy,
  milestoneBadge,
} from "./leaderboard-helpers";

export function LeaderboardCard(): ReactElement {
  const [window, setWindow] = useState<string>(LEADERBOARD_DEFAULT_WINDOW);
  const [data, setData] = useState<ReferralLeaderboardResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [loadedWindow, setLoadedWindow] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (w: string): Promise<void> => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setErr(null);
    try {
      const res = await referralsLeaderboardApi.get({
        window: w,
        limit: LEADERBOARD_LIMIT,
      });
      if (requestId !== requestIdRef.current) return;
      if (res.error) setErr(res.error.message);
      else {
        const decoded = decodeReferralLeaderboard(res.data);
        if (!decoded) {
          setErr("The referral leaderboard returned an invalid response.");
          return;
        }
        setData(decoded);
        setLoadedWindow(w);
      }
    } catch {
      if (requestId === requestIdRef.current) {
        setErr("Moosewave couldn't load the referral leaderboard.");
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(window);
    return () => {
      requestIdRef.current += 1;
    };
  }, [load, window]);

  const scopedData = loadedWindow === window ? data : null;
  const items = scopedData?.items ?? [];
  const columns: readonly DataTableColumn<
    ReferralLeaderboardResponse["items"][number]
  >[] = [
    {
      id: "rank",
      header: "Rank",
      width: "80px",
      align: "end",
      className: "tabular",
      cell: (item) => `#${item.rank}`,
    },
    {
      id: "referrer",
      header: "Referrer",
      width: "260px",
      cell: (item) => (
        <span
          className="pw-table-truncate mono"
          style={{ fontSize: 12 }}
          aria-label={`Masked referrer address ${item.referrer_email_masked}`}
        >
          {item.referrer_email_masked}
        </span>
      ),
    },
    {
      id: "conversions",
      header: "Conversions",
      width: "130px",
      align: "end",
      className: "tabular",
      cell: (item) => (item.conversions ?? 0).toLocaleString(),
    },
    {
      id: "milestone",
      header: "Milestone",
      width: "180px",
      cell: (item) => {
        const badge = milestoneBadge(item.milestone);
        return badge ? (
          <span className="badge success">{badge}</span>
        ) : (
          <span className="muted">—</span>
        );
      },
    },
  ];

  return (
    <>
      <SectionHeader
        title="Leaderboard"
        description="Historical credited records in the selected creation-time window. The displayed milestone is calculated from the current stored program, not an immutable reward grant."
        helpText="Emails are masked server-side (a***@domain). This report is directional: live signup qualification, expiry, and reward-grade fraud verification are not yet release-qualified."
        actions={
          <div className="row" style={{ gap: 4 }}>
            {LEADERBOARD_WINDOWS.map((w) => (
              <button
                key={w.value}
                type="button"
                className={`chip${window === w.value ? " is-active" : ""}`}
                aria-pressed={window === w.value}
                onClick={() => {
                  setErr(null);
                  setWindow(w.value);
                }}
                aria-label={`Show conversions from the last ${w.days} days`}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      {err ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <span>Couldn&apos;t load leaderboard: {err}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load(window)}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div
        style={{
          marginBottom: 16,
          opacity: loading && scopedData ? 0.65 : 1,
        }}
      >
        <DataTable
          caption="Referral leaderboard"
          description={
            loading && scopedData
              ? "Refreshing · showing the last verified ranking"
              : `Credited conversions · ${scopedData?.window_days ?? window.replace(/\D/g, "")} day window`
          }
          columns={columns}
          rows={items}
          getRowKey={(item) => `${item.rank}-${item.referrer_email_masked}`}
          loading={scopedData === null && !err}
          loadingLabel="Loading the referral leaderboard…"
          emptyState={
            err
              ? "Leaderboard data is unavailable for this window. Retry to load it."
              : leaderboardEmptyCopy(scopedData?.window_days ?? 90)
          }
          density="compact"
        />
      </div>
    </>
  );
}
