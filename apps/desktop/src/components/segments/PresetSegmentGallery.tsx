/**
 * PresetSegmentGallery — the "Recipes" section on the Segments page
 * (full-surface wiring #25).
 *
 * Backend surfaces consumed (apps/api/internal/preset_segments):
 *   GET /api/v1/preset-segments              → {presets[], count}
 *   GET /api/v1/preset-segments/{key}/list   → paged member preview
 *
 * Presets are computed live by server-side SQL — they are NOT saved
 * segments, so there's no direct "materialize" endpoint. The closest
 * honest path to a real segment is the existing compile-from-text →
 * create flow: "Recreate as segment" hands the preset's own prose
 * definition to the NL builder, where the operator reviews the
 * compiled rule + live count before saving. The card copy says the
 * result may not match the preset's SQL exactly.
 */

import { type ReactElement, useEffect, useState } from "react";

import {
  type PresetSegment,
  type PresetSegmentSubscriber,
  presetSegmentsApi,
} from "../../lib/api/preset-segments";
import { fmtDate } from "../../lib/format-date";
import { Modal } from "../Modal";
import { SectionHeader } from "../SectionHeader";
import { presetPageWindow } from "./preset-segments-helpers";

const PREVIEW_PAGE = 25;

interface Props {
  /** Editor+ can recreate presets as saved segments. */
  canMutate: boolean;
  /** Open the NL segment builder seeded with the preset definition. */
  onRecreate: (preset: PresetSegment) => void;
}

interface PreviewState {
  preset: PresetSegment;
  offset: number;
  rows: PresetSegmentSubscriber[] | null;
  err: string | null;
}

export function PresetSegmentGallery({
  canMutate,
  onRecreate,
}: Props): ReactElement {
  const [presets, setPresets] = useState<PresetSegment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await presetSegmentsApi.list();
    if (res.error) {
      setErr(res.error.message);
      setPresets(null);
    } else {
      setPresets(res.data?.presets ?? []);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const loadPreviewPage = async (
    preset: PresetSegment,
    offset: number,
  ): Promise<void> => {
    setPreview({ preset, offset, rows: null, err: null });
    const res = await presetSegmentsApi.subscribers(preset.key, {
      limit: PREVIEW_PAGE,
      offset,
    });
    setPreview((prev) => {
      // The operator may have closed the modal or paged again while
      // this request was in flight — only land matching results.
      if (!prev || prev.preset.key !== preset.key || prev.offset !== offset) {
        return prev;
      }
      if (res.error) {
        return { ...prev, rows: [], err: res.error.message };
      }
      return { ...prev, rows: res.data?.subscribers ?? [], err: null };
    });
  };

  const pager = preview
    ? presetPageWindow(
        preview.offset,
        PREVIEW_PAGE,
        preview.rows?.length ?? 0,
        preview.preset.count,
      )
    : null;

  return (
    <section style={{ marginTop: 28 }}>
      <SectionHeader
        title="Recipes"
        description="Ready-made cohorts computed live from your subscriber and engagement data — preview members instantly, no setup."
        helpText="Counts are computed when this section loads and refresh with it. Recipes are live server-side queries, not saved segments."
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      {!canMutate ? (
        <p
          id="preset-segment-write-reason"
          className="muted"
          style={{ fontSize: 11, margin: "0 0 10px" }}
        >
          Viewer access can preview recipes but cannot create segments.
        </p>
      ) : null}

      {err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load preset segments: {err}</span>
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
      ) : (presets?.length ?? 0) === 0 ? (
        <div className="pw-chart-empty">
          No preset segments available from the server.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {presets!.map((p) => (
            <div
              key={p.key}
              className="card"
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</div>
              <div
                className="muted"
                style={{ fontSize: 12, lineHeight: 1.45, flex: 1 }}
              >
                {p.description}
              </div>
              <div className="tabular" style={{ fontSize: 12 }}>
                <strong>{p.count.toLocaleString()}</strong>{" "}
                <span className="muted">
                  subscriber{p.count === 1 ? "" : "s"} right now
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void loadPreviewPage(p, 0)}
                >
                  Preview members
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    if (!canMutate) return;
                    onRecreate(p);
                  }}
                  aria-disabled={!canMutate || undefined}
                  aria-describedby={
                    !canMutate ? "preset-segment-write-reason" : undefined
                  }
                >
                  Recreate as segment
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ----- member preview modal ----- */}
      <Modal
        open={preview != null}
        onClose={() => setPreview(null)}
        title={preview ? `${preview.preset.label} — members` : "Members"}
        description="A live page of the subscribers matching this recipe right now."
      >
        {preview ? (
          <>
            {preview.err ? (
              <div className="notice" role="alert">
                <span>Couldn&apos;t load members: {preview.err}</span>
              </div>
            ) : preview.rows === null ? (
              <div style={{ padding: 8 }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skel-row" />
                ))}
              </div>
            ) : preview.rows.length === 0 ? (
              <div className="pw-chart-empty">
                {preview.offset === 0
                  ? "No subscribers match this recipe right now."
                  : "No members on this page — the cohort shrank since the previous page."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 90px 110px",
                    gap: 8,
                    padding: "0 10px",
                    fontSize: 11,
                    color: "var(--pw-fg-subtle)",
                  }}
                >
                  <span>Email</span>
                  <span style={{ textAlign: "right" }}>Status</span>
                  <span style={{ textAlign: "right" }}>Joined</span>
                </div>
                {preview.rows.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 90px 110px",
                      gap: 8,
                      alignItems: "center",
                      padding: "6px 10px",
                      background: "var(--pw-bg-elev-2)",
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={s.email}
                    >
                      {s.email}
                    </span>
                    <span
                      className="muted"
                      style={{ fontSize: 11, textAlign: "right" }}
                    >
                      {s.status}
                    </span>
                    <span
                      className="muted tabular"
                      style={{ fontSize: 10, textAlign: "right" }}
                    >
                      {fmtDate(s.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div
              className="pagination"
              style={{ marginTop: 10, justifyContent: "flex-start" }}
            >
              <button
                type="button"
                className="btn btn-sm"
                disabled={!pager?.hasPrev || preview.rows === null}
                onClick={() =>
                  void loadPreviewPage(
                    preview.preset,
                    Math.max(0, preview.offset - PREVIEW_PAGE),
                  )
                }
              >
                Prev
              </button>
              <span className="muted tabular" style={{ fontSize: 12 }}>
                {preview.rows === null ? "Loading…" : pager?.rangeLabel}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!pager?.hasNext || preview.rows === null}
                onClick={() =>
                  void loadPreviewPage(
                    preview.preset,
                    preview.offset + PREVIEW_PAGE,
                  )
                }
              >
                Next
              </button>
            </div>
          </>
        ) : null}
      </Modal>
    </section>
  );
}
