/**
 * DemographicsCard — SUB-063 single inferred-demographic card with a
 * visual confidence meter.
 *
 * Renders one confidence-labelled inferred demographic (gender / age
 * group / interests): a label, the inferred value (interests render as a
 * comma-joined list), and a horizontal confidence bar coloured by band
 * (high / medium / low) with the percentage. Confidence is the model
 * score in [0,1] from subscriber_computed_traits.confidence. The card is
 * presentation-only; the panel decides when to render it.
 */

import { type ReactElement } from "react";

import { type DemographicTrait } from "../../lib/api-client";

interface Props {
  label: string;
  trait: DemographicTrait;
}

/** Coerce an inferred-demographic trait value into a display string. */
export function demographicDisplayValue(value: unknown): string {
  if (value == null) return "—";
  if (Array.isArray(value)) {
    return value.map((v) => String(v)).join(", ") || "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  const s = String(value).trim();
  return s === "" ? "—" : s;
}

/** Confidence band → meter colour token + label. */
export function demographicConfidenceBand(c: number): {
  color: string;
  label: string;
} {
  if (c >= 0.75) return { color: "var(--pw-success)", label: "High" };
  if (c >= 0.45) return { color: "var(--pw-warning)", label: "Medium" };
  return { color: "var(--pw-danger)", label: "Low" };
}

export function DemographicsCard({ label, trait }: Props): ReactElement {
  const value = demographicDisplayValue(trait.value);
  const conf =
    typeof trait.confidence === "number" &&
    Number.isFinite(trait.confidence) &&
    trait.confidence >= 0 &&
    trait.confidence <= 1
      ? trait.confidence
      : null;
  const band = conf != null ? demographicConfidenceBand(conf) : null;
  const pct = conf != null ? Math.round(conf * 100) : null;

  return (
    <div
      style={{
        background: "var(--pw-bg-elev-2)",
        borderRadius: 4,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span className="muted" style={{ fontSize: 11, fontWeight: 600 }}>
          {label}
        </span>
        {band && pct != null ? (
          <span className="muted tabular" style={{ fontSize: 11 }}>
            {band.label} · {pct}%
          </span>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={value}
      >
        {value}
      </div>
      {conf != null && band ? (
        <div
          style={{
            height: 6,
            borderRadius: 3,
            background: "var(--pw-bg)",
            overflow: "hidden",
            marginTop: 6,
          }}
          role="meter"
          aria-valuenow={pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} confidence ${pct}%`}
          aria-valuetext={`${band.label} confidence · ${pct}%`}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.max(4, pct ?? 0)}%`,
              background: band.color,
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
              borderRadius: 3,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
