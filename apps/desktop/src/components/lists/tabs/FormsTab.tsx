/**
 * FormsTab — forms that feed subscribers into this list.
 *
 * Wave-2 (GAP-LS-127). Simple table of form name, hosted URL, and
 * view + submission counts. Read-only — form CRUD lives in the
 * Forms section.
 */

import { type ReactElement, useEffect, useState } from "react";

import { setSection } from "../../../lib/store";
import {
  type List,
  type ListFormSummary,
  listsFormsApi,
} from "../../../lib/api-client";
import { fmtDate } from "../../../lib/format-date";

interface Props {
  list: List;
}

export function FormsTab({ list }: Props): ReactElement {
  const [forms, setForms] = useState<ListFormSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await listsFormsApi.list(list.id);
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        setForms([]);
      } else {
        setForms(res.data?.items ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div className="muted" style={{ fontSize: 12 }}>
          Forms that subscribe people to <code>{list.name}</code>.
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setSection("forms")}
        >
          Manage forms →
        </button>
      </div>

      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load forms: {err}</span>
        </div>
      ) : null}

      {loading ? (
        <>
          <div className="skel-row" />
          <div className="skel-row" />
        </>
      ) : forms.length === 0 ? (
        <div className="pw-chart-empty">
          No forms feed this list yet. Create a form and pick{" "}
          <code>{list.name}</code> as the destination to start capturing
          signups.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 80px 80px 100px",
              gap: 8,
              padding: "4px 10px",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: "var(--pw-fg-subtle)",
            }}
          >
            <span>Form</span>
            <span style={{ textAlign: "right" }}>Views</span>
            <span style={{ textAlign: "right" }}>Subs</span>
            <span style={{ textAlign: "right" }}>Created</span>
          </div>
          {forms.map((f) => (
            <div
              key={f.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 80px 80px 100px",
                gap: 8,
                alignItems: "center",
                padding: "6px 10px",
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "var(--pw-fg)",
                  }}
                  title={f.name}
                >
                  {f.name}
                </div>
                {f.url ? (
                  <div
                    className="muted"
                    style={{
                      fontSize: 10,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={f.url}
                  >
                    {f.url}
                  </div>
                ) : null}
              </div>
              <span
                className="tabular"
                style={{ fontSize: 11, textAlign: "right" }}
              >
                {(f.view_count ?? 0).toLocaleString()}
              </span>
              <span
                className="tabular"
                style={{ fontSize: 11, textAlign: "right" }}
              >
                {(f.submission_count ?? 0).toLocaleString()}
              </span>
              <span
                className="muted tabular"
                style={{ fontSize: 10, textAlign: "right" }}
              >
                {f.created_at ? fmtDate(f.created_at) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
