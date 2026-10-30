/**
 * AudienceDestinationPreview — SUB-113 consent-aware exclusion preview.
 *
 * Resolves a saved destination's source members and reports how many the
 * consent firewall would withhold (by purpose), WITHOUT shipping anything.
 * Mirrors the audience-sync exclusion preview: an advisory count that
 * never gates the sync.
 *
 * Backend: GET /api/v1/audience-destinations/{id}/preview.
 */

import {
  useEffect,
  useState,
  type ReactElement,
} from "react";

import {
  audienceDestinationsApi,
  type AudienceDestinationPreview as PreviewData,
} from "../lib/api-client";

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger" | "success";
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: "8px 10px",
        minWidth: 0,
      }}
    >
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div
        style={{
          fontWeight: 600,
          fontSize: 16,
          marginTop: 2,
          color:
            tone === "danger"
              ? "var(--pw-danger)"
              : tone === "success"
                ? "var(--pw-success)"
                : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export function AudienceDestinationPreview({
  destinationId,
}: {
  destinationId: string;
}): ReactElement {
  const [data, setData] = useState<PreviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await audienceDestinationsApi.preview(destinationId);
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        setErr(
          res.error.status === 503
            ? "Preview needs the sync runner, which isn't enabled on this server."
            : res.error.message,
        );
        setData(null);
        return;
      }
      setData(res.data ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [destinationId]);

  if (loading) {
    return (
      <p className="muted" style={{ fontSize: 13 }}>
        Resolving audience + consent exclusions…
      </p>
    );
  }
  if (err) {
    return (
      <div className="notice" role="alert">
        <span>{err}</span>
      </div>
    );
  }
  if (!data) return <p className="muted">No preview available.</p>;

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 10,
        }}
      >
        <Cell label="Audience" value={data.total_members.toLocaleString()} />
        <Cell
          label="Excluded by consent"
          value={data.excluded_count.toLocaleString()}
          tone={data.excluded_count > 0 ? "danger" : undefined}
        />
        <Cell
          label="Deliverable"
          value={data.deliverable.toLocaleString()}
          tone="success"
        />
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        {data.firewall_active
          ? "The consent firewall withholds members who haven't opted in for this purpose. Nothing is shipped by this preview."
          : "The consent firewall is not active on this server — no members are withheld."}
        {data.truncated ? " (audience truncated to the preview cap)" : ""}
      </p>
    </div>
  );
}
