/**
 * SyncConsentPreviewPanel — the "−N excluded" pre-run disclosure for an
 * audience sync (Consent-Safe Activation Firewall, feature #2).
 *
 * Mirrors AudiencePreviewPanel.tsx exactly: it loads a real count from
 * the server and renders it honestly. Before a sync runs, the operator
 * sees how many profiles the firewall will withhold (and why), so they
 * are never surprised by an exclusion after the fact.
 *
 *   - "N recipients in [source]"  (audience_count)
 *   - "− M excluded (K by consent · L by suppression)"
 *   - "= D will be synced"
 *   - "Purpose: targeted_ads (meta destination)"  (the WHY, server-derived)
 *
 * Honest-UI:
 *   - The pre-flight count is an ESTIMATE (computed against the CURRENT
 *     consent/suppression state, not the state at run time) — so it
 *     carries an EstimateBadge. The post-run excluded_count in the runs
 *     slideover is exact and carries no badge.
 *   - On wire failure / -1 sentinel the panel renders a dashed-border
 *     "Exclusion count unavailable" line — NEVER "0 excluded" (a lie).
 *     The error is in the PREVIEW, never a gate: the parent's Run button
 *     stays enabled.
 *   - The count is bubbled up via onExcludedCountChange so the confirm
 *     button can read "Run now (−12 excluded)".
 */

import { type ReactElement, useEffect, useState } from "react";

import { audienceSyncsApi, type SyncExclusionPreview } from "../../lib/api-client";
import {
  ComputedFrom,
  EstimateBadge,
} from "../common/Provenance";
import {
  exclusionBreakdown,
  excludedTotal,
  formatCount,
  isPreviewUnavailable,
  purposeDisclosure,
  willSyncCount,
} from "../../lib/consent-firewall-helpers";

interface Props {
  syncId: string;
  /** Optional human label for the source ("list", segment name, …). */
  sourceLabel?: string;
  /** Optional destination type for the purpose disclosure parenthetical. */
  destinationType?: string;
  /** Bubbles up the excluded total (null when unavailable). */
  onExcludedCountChange?: (n: number | null) => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; preview: SyncExclusionPreview }
  | { kind: "error"; message: string };

const panelBase = {
  border: "1px solid var(--pw-border)",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  fontSize: 13,
} as const;

export function SyncConsentPreviewPanel({
  syncId,
  sourceLabel,
  destinationType,
  onExcludedCountChange,
}: Props): ReactElement {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      const res = await audienceSyncsApi.previewExclusions(syncId);
      if (cancelled) return;
      if (res.error) {
        setState({ kind: "error", message: res.error.message });
        // Unknown ≠ zero: bubble null so the parent renders a neutral
        // Run button, never "−0 excluded".
        onExcludedCountChange?.(null);
        return;
      }
      setState({ kind: "ready", preview: res.data });
      onExcludedCountChange?.(excludedTotal(res.data));
    })();
    return () => {
      cancelled = true;
    };
  }, [syncId, onExcludedCountChange]);

  if (state.kind === "loading") {
    return (
      <div className="sync-consent-preview" aria-busy="true" style={panelBase}>
        <div
          className="skel"
          style={{ height: 12, width: "55%", marginBottom: 8 }}
        />
        <div className="skel" style={{ height: 12, width: "70%" }} />
      </div>
    );
  }

  if (state.kind === "error") {
    // Wire failure: never show 0. The run is NOT blocked by a preview
    // error — the parent keeps its Run button enabled.
    return (
      <div
        className="muted"
        role="status"
        style={{
          border: "1px dashed var(--pw-border)",
          borderRadius: 8,
          padding: 10,
          marginBottom: 12,
          fontSize: 12,
        }}
      >
        Exclusion count unavailable ({state.message}).
      </div>
    );
  }

  const p = state.preview;
  const source = (sourceLabel ?? "").trim() || "this audience";

  // Honest fallback: if the source itself couldn't be resolved, show the
  // unavailable line rather than a fabricated breakdown.
  if (isPreviewUnavailable(p)) {
    return (
      <div
        className="muted"
        role="status"
        style={{
          border: "1px dashed var(--pw-border)",
          borderRadius: 8,
          padding: 10,
          marginBottom: 12,
          fontSize: 12,
        }}
      >
        Exclusion count unavailable for {source}.
      </div>
    );
  }

  const total = excludedTotal(p);
  const willSync = willSyncCount(p);
  const breakdown = exclusionBreakdown(p);

  return (
    <div
      className="sync-consent-preview"
      style={{ ...panelBase, background: "var(--pw-bg-elev)" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span className="tabular" style={{ fontWeight: 600 }}>
          {formatCount(p.audience_count)}
        </span>
        <span>
          recipient{p.audience_count === 1 ? "" : "s"} in {source}
        </span>
        <EstimateBadge
          label="Estimate"
          title="Computed against current consent + suppression state. The exact count is recorded when the sync runs."
        />
      </div>

      {total !== null && total > 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          − {formatCount(total)} excluded{breakdown ? ` ${breakdown}` : ""}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          No profiles will be excluded.
        </div>
      )}

      <div
        className="tabular"
        style={{ marginTop: 6, fontSize: 13, fontWeight: 600 }}
      >
        = {formatCount(willSync)} will be synced
      </div>

      <div style={{ marginTop: 8 }}>
        <ComputedFrom n={p.audience_count} m={p.audience_count} unit="recipients" />
      </div>

      <div
        className="muted"
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: "1px solid var(--pw-border)",
          fontSize: 12,
        }}
      >
        {purposeDisclosure(p, destinationType)}
      </div>
    </div>
  );
}
