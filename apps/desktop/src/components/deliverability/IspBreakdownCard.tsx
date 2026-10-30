/**
 * IspBreakdownCard — #41 of the 2026-06-11 wiring backlog.
 *
 * Per-ISP engagement table: a domain-level problem (e.g. Outlook
 * bouncing at 60%) drowns inside the tenant-wide averages, so this
 * card breaks opens/clicks/bounces/complaints out per mailbox
 * provider. A campaign selector flips between the tenant-wide window
 * (GET /isp-breakdown) and the per-campaign variant
 * (GET /isp-breakdown/by-campaign/{id}).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { type ISPBucket, ispBreakdownApi } from "../../lib/api-client";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import { CampaignSelect } from "./CampaignSelect";
import {
  formatRate,
  ispRowSeverity,
  sortIspBuckets,
} from "./isp-breakdown-helpers";
import {
  parseCampaignIspResponse,
  parseTenantIspResponse,
} from "./diagnostics-response-contract";

export function IspBreakdownCard(): ReactElement {
  /** "" = tenant-wide (default window), otherwise a campaign id. */
  const [campaignId, setCampaignId] = useState("");
  const [buckets, setBuckets] = useState<ISPBucket[] | null>(null);
  const [windowDays, setWindowDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const loadedIdentityRef = useRef<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setErr(null);
    if (loadedIdentityRef.current !== campaignId) {
      setBuckets(null);
      setWindowDays(null);
    }
    try {
      if (campaignId) {
        const res = await ispBreakdownApi.byCampaign(campaignId);
        if (requestId !== requestIdRef.current) return;
        if (res.error) {
          setErr(res.error.message);
        } else {
          const parsed = parseCampaignIspResponse(res.data, campaignId);
          if (!parsed) {
            setErr("The ISP breakdown service returned a malformed response.");
          } else {
            setBuckets(parsed);
            setWindowDays(null);
            loadedIdentityRef.current = campaignId;
          }
        }
      } else {
        const res = await ispBreakdownApi.tenant();
        if (requestId !== requestIdRef.current) return;
        if (res.error) {
          setErr(res.error.message);
        } else {
          const parsed = parseTenantIspResponse(res.data);
          if (!parsed) {
            setErr("The ISP breakdown service returned a malformed response.");
          } else {
            setBuckets(parsed.buckets);
            setWindowDays(parsed.windowDays);
            loadedIdentityRef.current = campaignId;
          }
        }
      }
    } catch {
      if (requestId === requestIdRef.current) {
        setErr("Moosewave couldn't load the ISP breakdown.");
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load]);

  const sorted = buckets ? sortIspBuckets(buckets) : null;
  const columns: readonly DataTableColumn<ISPBucket>[] = [
    {
      id: "isp",
      header: "ISP",
      width: "240px",
      cell: (bucket) => (
        <span
          className="pw-table-truncate"
          title={`${bucket.isp} · ${bucket.subscribers.toLocaleString()} subscriber(s)`}
          style={{ fontWeight: 500 }}
        >
          {bucket.isp}
          {ispRowSeverity(bucket) === "warn" ? (
            <span className="badge warning" style={{ marginLeft: 6 }}>
              attention
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "sent",
      header: "Sent",
      align: "end",
      cell: (bucket) => bucket.sent.toLocaleString(),
    },
    {
      id: "open",
      header: "Open",
      align: "end",
      cell: (bucket) => formatRate(bucket.open_rate),
    },
    {
      id: "click",
      header: "Click",
      align: "end",
      cell: (bucket) => formatRate(bucket.click_rate),
    },
    {
      id: "bounce",
      header: "Bounce",
      align: "end",
      cell: (bucket) => formatRate(bucket.bounce_rate),
    },
    {
      id: "complaint",
      header: "Complaint",
      align: "end",
      cell: (bucket) => formatRate(bucket.complaint_rate),
    },
  ];
  const description = campaignId
    ? "Engagement per mailbox provider for the selected campaign"
    : windowDays != null
      ? `Engagement per mailbox provider · last ${windowDays}d`
      : "Engagement per mailbox provider";

  return (
    <div className="card" style={{ padding: 16 }}>
      {err ? (
        <div className="notice" role="alert" style={{ marginBottom: 10 }}>
          <span>Couldn&apos;t load ISP breakdown: {err}</span>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: 8 }}
            onClick={() => void load()}
            disabled={loading}
          >
            Retry
          </button>
        </div>
      ) : null}
      <DataTable
        caption="ISP breakdown"
        description={description}
        columns={columns}
        rows={sorted ?? []}
        getRowKey={(bucket) => bucket.isp}
        loading={loading}
        loadingLabel="Loading ISP breakdown…"
        emptyState={
          err
            ? "ISP breakdown data is unavailable. Retry to load it."
            : campaignId
              ? "No per-ISP events recorded for this campaign."
              : "No sends in the window — nothing to break down yet."
        }
        density="compact"
        columnControls={
          <div style={{ minWidth: 220 }}>
            <CampaignSelect
              id="isp-breakdown-campaign"
              ariaLabel="Campaign for ISP breakdown"
              value={campaignId}
              onChange={setCampaignId}
              placeholder="All campaigns (tenant window)"
              disabled={loading}
            />
          </div>
        }
      />
    </div>
  );
}
