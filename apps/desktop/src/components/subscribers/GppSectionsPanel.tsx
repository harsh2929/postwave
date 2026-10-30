/**
 * GppSectionsPanel — SUB-120 IAB Global Privacy Platform (GPP) sections for
 * one profile, shown in the subscriber slideover Privacy tab.
 *
 * A Consent Management Platform (CMP) emits a per-jurisdiction GPP string
 * (us-national, California, EU TCF, …) when a data subject sets their
 * privacy preferences. Moosewave stores those strings verbatim on the
 * subscriber — no decoding at this phase — and appends every change to an
 * audit ledger so an auditor can reconstruct who set which jurisdiction's
 * section, when, and from where (CMP webhook vs. manual admin override).
 *
 * This panel is READ-ONLY at MVP: there is no write affordance here.
 * Manual edits are restricted to the admin-only PATCH endpoint, and CMP
 * ingest is webhook-driven — both out of band of this drawer.
 *
 * Backed by:
 *   GET /api/v1/subscribers/{id}/gpp
 * (apps/api/internal/subscribers/gpp.go).
 *
 * Graceful degradation: a 404 (routes not deployed) hides the whole
 * section via onUnavailable, matching the slideover convention. A
 * subscriber with no recorded GPP sections renders an honest empty state.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type GppAuditEntry,
  type GppSectionsResponse,
  api,
} from "../../lib/api-client";
import { fmtDateTime } from "../../lib/format-date";
import { InlineHelp } from "../InlineHelp";

interface Props {
  /** Subscriber UUID (the GPP endpoints key rows by it). */
  subscriberId: string;
  /** Fired when the GPP routes are not deployed (404). */
  onUnavailable?: () => void;
}

/** Human label for a known audit-trail source; falls back to the raw value
 *  for any future provenance the backend adds. */
function sourceLabel(source: string): string {
  switch (source) {
    case "cmp_webhook":
      return "CMP webhook";
    case "manual_override":
      return "Admin";
    case "import":
      return "Import";
    case "api":
      return "API";
    default:
      return source;
  }
}

export function GppSectionsPanel({
  subscriberId,
  onUnavailable,
}: Props): ReactElement | null {
  const [data, setData] = useState<GppSectionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    setData(null);
    void (async () => {
      const res = await api.getSubscriberGpp(subscriberId);
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        if (res.error.kind === "http" && res.error.status === 404) {
          onUnavailable?.();
          return;
        }
        setErrMsg(res.error.message);
        return;
      }
      setData(res.data);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriberId]);

  if (loading) {
    return (
      <section style={{ marginTop: 12 }}>
        <div className="label">Privacy (GPP)</div>
        <div className="skel" style={{ height: 64 }} />
      </section>
    );
  }

  const jurisdictions = data ? Object.keys(data.sections).sort() : [];
  const audit: GppAuditEntry[] = data?.audit ?? [];

  return (
    <section style={{ marginTop: 12 }}>
      <div
        className="label"
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        Privacy (GPP)
        <InlineHelp text="IAB Global Privacy Platform consent strings recorded per jurisdiction (e.g. US national, California). Strings are stored verbatim; decoding is a future phase. Edits are admin- or CMP-webhook-driven only." />
      </div>

      {errMsg ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Couldn&apos;t load GPP sections: {errMsg}
        </div>
      ) : jurisdictions.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No GPP consent sections recorded for this profile.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "6px 10px",
            alignItems: "center",
            fontSize: 12,
          }}
        >
          {/* Header row */}
          <span className="muted" style={{ fontSize: 11 }}>
            Jurisdiction
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Encoded section
          </span>

          {jurisdictions.map((j) => (
            <SectionRow
              key={j}
              jurisdiction={j}
              value={data?.sections[j] ?? ""}
            />
          ))}
        </div>
      )}

      {/* Audit-trail footer: who set which jurisdiction's section, when,
          and from where. Newest-first, capped server-side at 100. */}
      {audit.length > 0 ? (
        <details style={{ marginTop: 10 }}>
          <summary
            className="muted"
            style={{ fontSize: 11, cursor: "pointer" }}
          >
            Audit trail ({audit.length})
          </summary>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {audit.map((e) => (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  flexWrap: "wrap",
                }}
              >
                <span className="badge" style={{ fontSize: 10 }}>
                  {e.jurisdiction}
                </span>
                <span className="muted">{sourceLabel(e.source)}</span>
                <span className="muted tabular" title={e.created_at}>
                  · {fmtDateTime(e.created_at)}
                </span>
                {e.section_value === "" ? (
                  <span className="muted" style={{ fontStyle: "italic" }}>
                    (cleared)
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

/** One jurisdiction row. The encoded GPP string can be long, so it's
 *  rendered monospace and clipped with an ellipsis; the full value is in
 *  the title attribute. A "View Decoded" affordance is intentionally
 *  deferred to a future decoding phase. */
function SectionRow({
  jurisdiction,
  value,
}: {
  jurisdiction: string;
  value: string;
}): ReactElement {
  return (
    <>
      <span style={{ fontWeight: 500 }}>{jurisdiction}</span>
      <span
        className="mono"
        title={value}
        style={{
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {value || "—"}
      </span>
    </>
  );
}
