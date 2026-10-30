/**
 * SegmentTemplateGallery — the "Predictive templates" section on the
 * Segments page (SUB-034).
 *
 * Backend surface consumed (apps/api/internal/segments/templates.go):
 *   GET  /api/v1/segments/templates → {items[]}  (static catalog)
 *   POST /api/v1/segments           → materialize one as a saved segment
 *
 * Templates are opinionated, pre-wired predictive audiences (High-value,
 * At-risk, Likely-to-churn) built from the predictive.* / rfm.* predicate
 * fields the compiler already supports. There's no config UI — each card
 * is a one-click "Use template" that opens a small name-it modal and then
 * POSTs the template's predicate_json to /segments (isTemplate=true), so
 * the result is a real saved segment with the full lifecycle (preview,
 * recompute, snapshots).
 *
 * Parallels PresetSegmentGallery (the live-query "Recipes" section) but is
 * distinct: recipes are server-side queries with no materialize path,
 * whereas templates DO materialize directly into a saved segment.
 */

import { type ReactElement, useEffect, useState } from "react";

import { Modal, ModalFooter } from "../Modal";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { queueReceiptMessage } from "../../lib/api/result";
import {
  type Segment,
  type SegmentTemplate,
  segmentsClient,
} from "./segmentsClient";

interface Props {
  /** Editor+ can materialize a template into a saved segment. */
  canMutate: boolean;
  /** Called with the freshly-created segment so the parent can list it. */
  onCreated: (segment: Segment) => void;
}

/** Lightweight icon mapping from the backend's `icon_hint` to an inline
 *  glyph. Kept tiny + non-binding — an unknown hint falls back to a
 *  generic sparkle so a new server template never renders blank. */
function TemplateIcon({ hint }: { hint: string }): ReactElement {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (hint) {
    case "gem":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M6 3h12l4 6-10 12L2 9z" />
          <path d="M11 3 8 9l4 12 4-12-3-6" />
          <path d="M2 9h20" />
        </svg>
      );
    case "alert-triangle":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case "trending-down":
      return (
        <svg {...common} aria-hidden="true">
          <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
          <polyline points="16 17 22 17 22 11" />
        </svg>
      );
    default:
      return (
        <svg {...common} aria-hidden="true">
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
        </svg>
      );
  }
}

interface ApplyState {
  template: SegmentTemplate;
  name: string;
  submitting: boolean;
  err: string | null;
}

export function SegmentTemplateGallery({
  canMutate,
  onCreated,
}: Props): ReactElement | null {
  const [templates, setTemplates] = useState<SegmentTemplate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [apply, setApply] = useState<ApplyState | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await segmentsClient.listTemplates();
    if (res.error) {
      setErr(res.error.message);
      setTemplates(null);
    } else {
      setTemplates(res.data?.items ?? []);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const openApply = (template: SegmentTemplate): void => {
    setApply({
      template,
      name: template.suggested_name || template.label,
      submitting: false,
      err: null,
    });
  };

  const confirmApply = async (): Promise<void> => {
    if (!canMutate || !apply) return;
    const name = apply.name.trim();
    if (!name) {
      setApply((prev) => (prev ? { ...prev, err: "Name is required." } : prev));
      return;
    }
    setApply((prev) =>
      prev ? { ...prev, submitting: true, err: null } : prev,
    );
    const res = await segmentsClient.applyTemplate(apply.template, name);
    if (res.error) {
      setApply((prev) =>
        prev ? { ...prev, submitting: false, err: res.error.message } : prev,
      );
      return;
    }
    if (res.queued) {
      setApply(null);
      toast.info({
        message: queueReceiptMessage(res.receipt),
        detail: `“${name}” will appear after the server confirms the create.`,
      });
      return;
    }
    const created = res.data;
    setApply(null);
    if (created) {
      onCreated(created);
      toast.success(`Segment "${name}" created from template`);
    }
  };

  // Hide the whole section when the catalog is empty (e.g. an older
  // server without the templates route) — never show a dead header.
  if (!loading && !err && (templates?.length ?? 0) === 0) return null;

  return (
    <section style={{ marginTop: 28 }}>
      <SectionHeader
        title="Predictive templates"
        description="One-click starter audiences built from CLV, RFM, and churn-risk scoring formulas. Pick one, name it, and it becomes a live saved segment."
        helpText="Templates are opinionated, pre-wired segment definitions. The materialized segment uses the same lifecycle as any other — preview, recompute, and snapshot it like normal."
      />

      {!canMutate ? (
        <p
          id="segment-template-write-reason"
          className="muted"
          style={{ fontSize: 11, margin: "0 0 10px" }}
        >
          Viewer access can inspect templates but cannot create segments.
        </p>
      ) : null}

      {err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load predictive templates: {err}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            style={{ marginLeft: "auto" }}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div style={{ padding: 12 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel-row" />
          ))}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {(templates ?? []).map((t) => (
            <div
              key={t.key}
              className="card"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  aria-hidden="true"
                  style={{
                    color: "var(--pw-fg-subtle)",
                    display: "inline-flex",
                  }}
                >
                  <TemplateIcon hint={t.icon_hint} />
                </span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{t.label}</span>
              </div>
              <div
                className="muted"
                style={{ fontSize: 12, lineHeight: 1.45, flex: 1 }}
              >
                {t.description}
              </div>
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    if (!canMutate) return;
                    openApply(t);
                  }}
                  aria-disabled={!canMutate || undefined}
                  aria-describedby={
                    !canMutate ? "segment-template-write-reason" : undefined
                  }
                >
                  Use template
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ----- name-and-create modal ----- */}
      <Modal
        open={apply != null}
        onClose={() => (apply?.submitting ? undefined : setApply(null))}
        size="sm"
        title={
          apply ? `Create "${apply.template.label}" segment` : "New segment"
        }
        description="Name the segment. It's created immediately as a live saved segment from the template's predefined rules."
      >
        {apply ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="field">
              <label className="field-label" htmlFor="tpl-segment-name">
                Segment name
              </label>
              <input
                id="tpl-segment-name"
                className="input"
                type="text"
                value={apply.name}
                maxLength={200}
                disabled={apply.submitting}
                onChange={(e) =>
                  setApply((prev) =>
                    prev ? { ...prev, name: e.target.value, err: null } : prev,
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !apply.submitting) {
                    void confirmApply();
                  }
                }}
              />
              <div className="field-help">{apply.template.description}</div>
            </div>
            {apply.err ? <div className="field-error">{apply.err}</div> : null}
            <ModalFooter>
              <button
                type="button"
                className="btn"
                onClick={() => setApply(null)}
                disabled={apply.submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmApply()}
                disabled={apply.submitting}
              >
                {apply.submitting ? "Creating…" : "Create segment"}
              </button>
            </ModalFooter>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
