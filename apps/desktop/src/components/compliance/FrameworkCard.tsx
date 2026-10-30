/**
 * FrameworkCard — one tile in the Compliance grid. Refined PR 1.
 *
 * Shows the framework's short label, region chip, status pill,
 * blurb, and a small "what's needed" hint when not attested. Click
 * opens the detail panel. The card itself is intentionally compact
 * so the grid scans like a status board.
 */

import type { ReactElement } from "react";

import type { ComplianceProgram } from "../../lib/api-client";

import { type FrameworkMeta, metaFor } from "./FrameworkMeta";

interface Props {
  program: ComplianceProgram;
  onOpen: () => void;
}

function fmtRelative(s?: string): string {
  if (!s) return "—";
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return s;
  const diff = Math.round((t - Date.now()) / 1000);
  const past = diff < 0;
  const abs = Math.abs(diff);
  if (abs < 60) return past ? "just now" : "in a moment";
  if (abs < 3600)
    return past
      ? `${Math.floor(abs / 60)}m ago`
      : `in ${Math.floor(abs / 60)}m`;
  if (abs < 86400)
    return past
      ? `${Math.floor(abs / 3600)}h ago`
      : `in ${Math.floor(abs / 3600)}h`;
  if (abs < 86400 * 7)
    return past
      ? `${Math.floor(abs / 86400)}d ago`
      : `in ${Math.floor(abs / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function statusBadge(
  p: ComplianceProgram,
  meta: FrameworkMeta,
): {
  cls: string;
  label: string;
  title: string;
} {
  // Renewal-overdue check: if the framework normally renews and the
  // renewal date is in the past, surface "Renewal due" rather than
  // the bland "Attested" so an auditor sees the gap.
  const now = Date.now();
  const renewalT = p.renewalAt ? new Date(p.renewalAt).getTime() : NaN;
  if (
    p.status === "attested" &&
    Number.isFinite(renewalT) &&
    renewalT < now &&
    meta.renewalCadenceMonths !== null
  ) {
    return {
      cls: "is-overdue",
      label: "Renewal due",
      title: `Renewal was due ${fmtRelative(p.renewalAt)}.`,
    };
  }
  switch (p.status) {
    case "unsupported":
      return {
        cls: "is-unsupported",
        label: "Not supported",
        title: "Moosewave does not offer a BAA and must not be used for PHI.",
      };
    case "attested":
      return {
        cls: "is-attested",
        label: "Attested",
        title: p.attestedAt
          ? `Attested ${fmtRelative(p.attestedAt)}.`
          : "Attested.",
      };
    case "revoked":
      return {
        cls: "is-revoked",
        label: "Revoked",
        title: "Attestation has been revoked.",
      };
    default:
      return {
        cls: "is-not-started",
        label: "Not started",
        title: "No attestation on file yet.",
      };
  }
}

export function FrameworkCard({ program, onOpen }: Props): ReactElement {
  const meta = metaFor(program.framework);
  const badge = statusBadge(program, meta);
  return (
    <button
      type="button"
      className={`compliance-card compliance-card-${badge.cls}`}
      onClick={onOpen}
    >
      <div className="compliance-card-head">
        <span className="compliance-card-short">{meta.short}</span>
        <span
          className={`compliance-card-status ${badge.cls}`}
          title={badge.title}
        >
          {badge.label}
        </span>
      </div>
      <div className="compliance-card-region muted small">{meta.region}</div>
      <div className="compliance-card-blurb">{meta.blurb}</div>
      <div className="compliance-card-meta muted small">
        {program.status === "unsupported" ? (
          <>No BAA · PHI prohibited</>
        ) : program.status === "attested" && program.attestedAt ? (
          <>
            Attested {fmtRelative(program.attestedAt)}
            {program.renewalAt ? (
              <> · Renews {fmtRelative(program.renewalAt)}</>
            ) : null}
          </>
        ) : (
          <>
            {meta.gates.length} gate{meta.gates.length === 1 ? "" : "s"} to
            check
          </>
        )}
      </div>
    </button>
  );
}
