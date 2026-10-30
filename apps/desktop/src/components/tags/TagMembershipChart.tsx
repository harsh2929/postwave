import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { fmtDate, fmtDateTime, fmtDayMonth } from "../../lib/format-date";
import { type TagMembership, api } from "../../lib/api-client";
import { isTagMembership } from "./tagRemoteValidation";

interface Props {
  tagId: string;
  days?: number;
}

interface VerifiedMembership {
  tagId: string;
  days: number;
  value: TagMembership;
}

const LOAD_ERROR =
  "Membership history could not be verified. The previous verified view was kept.";

export function TagMembershipChart({ tagId, days = 30 }: Props): ReactElement {
  const requestRef = useRef(0);
  const [verified, setVerified] = useState<VerifiedMembership | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const data =
    verified?.tagId === tagId && verified.days === days ? verified.value : null;

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.tagMembership(tagId, days);
      if (requestId !== requestRef.current) return;
      if (
        result.error ||
        !isTagMembership(result.data) ||
        result.data.tag_id !== tagId ||
        result.data.days !== days
      ) {
        setError(LOAD_ERROR);
        return;
      }
      setVerified({ tagId, days, value: result.data });
    } catch {
      if (requestId === requestRef.current) setError(LOAD_ERROR);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [days, tagId]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  if (!data && loading) {
    return (
      <div className="tags-membership-state" role="status">
        <span className="spinner" aria-hidden="true" />
        Verifying membership history…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="tags-membership-state" role="alert">
        <p>{error ?? LOAD_ERROR}</p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }

  const complete = data.coverage.requested_window_complete;
  const coverageCopy = complete
    ? `Exact for the requested ${days}-day window.`
    : `Exact from ${fmtDate(data.coverage.coverage_started_at)}; the earlier part of the requested ${days}-day window is not covered.`;

  return (
    <div className="tags-membership-card">
      <div className="tag-detail-section-header">
        <div>
          <div className="label">Membership · last {days} days</div>
          <div className="field-help">
            As of {fmtDateTime(data.coverage.as_of)}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="notice tags-membership-stale" role="alert">
          {error}{" "}
          <button type="button" className="link" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="tags-membership-metrics" aria-label="Membership summary">
        <Metric label="Current" value={data.current_count} />
        <Metric
          label={complete ? "Joined" : "Joined in covered period"}
          value={data.added}
          tone="positive"
        />
        <Metric
          label={complete ? "Left" : "Left in covered period"}
          value={data.removed}
          tone="negative"
        />
      </div>

      <div className="tags-membership-coverage" role="note">
        <span
          className={
            complete ? "status-dot status-dot-ok" : "status-dot status-dot-warn"
          }
          aria-hidden="true"
        />
        <span>{coverageCopy}</span>
      </div>

      {data.daily.length > 0 ? (
        <>
          <MembershipBars data={data} />
          <MembershipTable data={data} />
        </>
      ) : (
        <div className="tags-membership-empty">
          No joins or departures were recorded in the covered period.
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "positive" | "negative";
}): ReactElement {
  return (
    <div className={`tags-membership-metric${tone ? ` is-${tone}` : ""}`}>
      <span>{label}</span>
      <strong className="tabular">{value.toLocaleString()}</strong>
    </div>
  );
}

function MembershipBars({ data }: { data: TagMembership }): ReactElement {
  const maximum = Math.max(
    1,
    ...data.daily.map((bucket) => Math.abs(bucket.net)),
  );
  return (
    <div className="tags-membership-chart" aria-hidden="true">
      {data.daily.map((bucket) => {
        const size = Math.max(
          2,
          Math.round((Math.abs(bucket.net) / maximum) * 42),
        );
        return (
          <span
            key={bucket.date}
            className={`tags-membership-bar${bucket.net < 0 ? " is-negative" : ""}`}
            style={
              { "--tag-membership-bar-size": `${size}px` } as CSSProperties
            }
            title={`${fmtDate(bucket.date)}: ${bucket.net > 0 ? "+" : ""}${bucket.net.toLocaleString()}`}
          />
        );
      })}
    </div>
  );
}

function MembershipTable({ data }: { data: TagMembership }): ReactElement {
  return (
    <details className="tags-membership-data">
      <summary>View daily values</summary>
      <div className="tags-membership-data-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Net change</th>
            </tr>
          </thead>
          <tbody>
            {data.daily.map((bucket) => (
              <tr key={bucket.date}>
                <th scope="row">{fmtDayMonth(bucket.date)}</th>
                <td className="tabular">
                  {bucket.net > 0 ? "+" : ""}
                  {bucket.net.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
