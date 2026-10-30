/**
 * ValidationResultsModal — per-row results of a bulk email-validation
 * run (#9, POST /email-validation/check-batch) launched from the
 * BulkActionBar.
 *
 * HONEST-UI: validation is surface-only. The modal displays verdicts
 * and reasons and changes NOTHING — no auto-suppress, no auto-delete.
 * The summary line comes from the server's own summary block.
 */

import { type ReactElement } from "react";

import type { EmailValidationBatchResponse } from "../../lib/api-client";
import { Modal, ModalFooter } from "../Modal";
import {
  summarizeValidationResults,
  verdictLabel,
} from "./subscriber-insights";

interface Props {
  open: boolean;
  onClose: () => void;
  response: EmailValidationBatchResponse | null;
  /** Selected rows that carried no email and were skipped client-side. */
  skipped: number;
  /** Exact validated-and-id-bearing scope available for a safe read-only action. */
  validSubsetCount?: number;
  validSubsetWithoutId?: number;
  exportingValidSubset?: boolean;
  onExportValidSubset?: () => void;
}

export function ValidationResultsModal({
  open,
  onClose,
  response,
  skipped,
  validSubsetCount = 0,
  validSubsetWithoutId = 0,
  exportingValidSubset = false,
  onExportValidSubset,
}: Props): ReactElement | null {
  if (!open || !response) return null;
  const summary = response.summary;
  const breakdown = summarizeValidationResults(response.results);
  const verdicts = Object.entries(breakdown.byVerdict).filter(
    ([v]) => v !== "ok",
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Email validation results"
      description="Syntax, MX, disposable-domain, and role-account checks. Read-only — no subscriber was changed or removed."
    >
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "baseline",
          marginBottom: 8,
          fontSize: 12,
        }}
      >
        <span>
          <strong className="tabular">{summary.total.toLocaleString()}</strong>{" "}
          checked
        </span>
        <span style={{ color: "var(--pw-success)" }}>
          <strong className="tabular">{summary.valid.toLocaleString()}</strong>{" "}
          valid
        </span>
        <span
          style={{
            color: summary.invalid > 0 ? "var(--pw-danger)" : undefined,
          }}
        >
          <strong className="tabular">
            {summary.invalid.toLocaleString()}
          </strong>{" "}
          invalid
        </span>
        {skipped > 0 ? (
          <span className="muted">
            {skipped.toLocaleString()} selected row
            {skipped === 1 ? "" : "s"} had no email and were skipped
          </span>
        ) : null}
      </div>

      {verdicts.length > 0 ? (
        <div
          className="muted"
          style={{
            fontSize: 11,
            marginBottom: 8,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {verdicts.map(([verdict, n]) => (
            <span key={verdict}>
              {verdictLabel(verdict)}: <span className="tabular">{n}</span>
            </span>
          ))}
        </div>
      ) : null}

      <div
        style={{
          maxHeight: 320,
          overflowY: "auto",
          border: "1px solid var(--pw-border)",
          borderRadius: 4,
        }}
      >
        {response.results.map((r, i) => (
          <div
            key={`${r.email}-${i}`}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.4fr) auto",
              gap: 8,
              padding: "6px 8px",
              borderBottom: "1px solid var(--pw-border)",
              fontSize: 12,
              alignItems: "baseline",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={r.email}
              >
                {r.email}
              </div>
              {r.reasons.length > 0 ? (
                <div className="muted" style={{ fontSize: 11 }}>
                  {r.reasons.join("; ")}
                </div>
              ) : null}
            </div>
            <span
              className="badge"
              style={{
                fontSize: 10,
                color: r.valid ? "var(--pw-success)" : "var(--pw-danger)",
              }}
            >
              {verdictLabel(r.verdict)}
            </span>
          </div>
        ))}
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Validation never deletes or suppresses anyone. Act on invalid rows
        yourself only after reviewing their reasons. The valid-only export below
        is read-only and uses the exact validated, id-bearing subset from this
        result.
      </div>

      {validSubsetWithoutId > 0 ? (
        <div className="notice warning" role="status" style={{ marginTop: 8 }}>
          {validSubsetWithoutId.toLocaleString()} valid result
          {validSubsetWithoutId === 1 ? " has" : "s have"} no stable subscriber
          id and cannot enter the valid-only export.
        </div>
      ) : null}

      <ModalFooter>
        {onExportValidSubset ? (
          <button
            type="button"
            className="btn"
            disabled={exportingValidSubset || validSubsetCount === 0}
            onClick={onExportValidSubset}
          >
            {exportingValidSubset
              ? "Preparing valid-only export…"
              : `Export valid subset (${validSubsetCount.toLocaleString()})`}
          </button>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </ModalFooter>
    </Modal>
  );
}
