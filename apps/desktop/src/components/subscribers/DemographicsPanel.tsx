/**
 * DemographicsPanel — SUB-063 confidence-labelled inferred demographics.
 *
 * Reads GET /api/v1/subscribers/{id}/demographics, which surfaces three
 * inferred computed traits (gender / age group / interests), each carrying
 * the model confidence in [0,1]. Renders one DemographicsCard per inferred
 * trait, with a visual confidence meter, plus a recency stamp from the most
 * recent trait. Inferred values are clearly framed as predictions.
 *
 * Self-contained (loads its own data, like CatalogAttributesPanel) so the
 * parent slideover's big Promise.all stays untouched. 404 (routes not
 * deployed) → the whole panel hides via onUnavailable, matching the
 * slideover's graceful-degradation convention.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import {
  type Demographics,
  type DemographicTrait,
  api,
} from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";
import {
  DemographicsCard,
  demographicConfidenceBand,
  demographicDisplayValue,
} from "./DemographicsCard";

interface Props {
  /** Subscriber UUID or email (the endpoint accepts both). */
  subscriberId: string;
  /** Fired when the demographics routes are not deployed (404). */
  onUnavailable?: () => void;
}

interface Row {
  label: string;
  trait: DemographicTrait;
}

/** The latest computed_at across the present traits, for the recency stamp. */
function latestComputedAt(rows: Row[]): string | null {
  let latest: number | null = null;
  let raw: string | null = null;
  for (const { trait } of rows) {
    if (!trait.computed_at) continue;
    const ts = Date.parse(trait.computed_at);
    if (Number.isNaN(ts)) continue;
    if (latest == null || ts > latest) {
      latest = ts;
      raw = trait.computed_at;
    }
  }
  return raw;
}

export function DemographicsPanel({
  subscriberId,
  onUnavailable,
}: Props): ReactElement | null {
  const [data, setData] = useState<Demographics | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrMsg(null);
    setData(null);
    void (async () => {
      try {
        const res = await api.getSubscriberDemographics(subscriberId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.error) {
          if (res.error.kind === "http" && res.error.status === 404) {
            onUnavailable?.();
            return;
          }
          setErrMsg("Inferred demographics could not be loaded.");
          return;
        }
        setData(res.data);
      } catch {
        if (controller.signal.aborted) return;
        setErrMsg("Inferred demographics could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriberId, reloadKey]);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const out: Row[] = [];
    if (data.gender) out.push({ label: "Gender", trait: data.gender });
    if (data.age_group) out.push({ label: "Age group", trait: data.age_group });
    if (data.interests) out.push({ label: "Interests", trait: data.interests });
    return out;
  }, [data]);

  const computedAt = useMemo(() => latestComputedAt(rows), [rows]);

  if (loading) {
    return (
      <section role="status" aria-label="Loading inferred demographics">
        <div className="label">Inferred demographics</div>
        <div className="skel" style={{ height: 64 }} aria-hidden="true" />
      </section>
    );
  }

  return (
    <section>
      <div className="label">Inferred demographics</div>
      {errMsg ? (
        <div className="notice" style={{ fontSize: 12 }} role="alert">
          <span>{errMsg}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          No inferred demographics yet — gender, age group and interests are
          predicted from profile signals.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="muted" style={{ fontSize: 11 }}>
            Predicted from profile signals — confidence-labelled, not
            self-reported.
          </div>
          {rows.map((row) => (
            <DemographicsCard
              key={row.label}
              label={row.label}
              trait={row.trait}
            />
          ))}
          {computedAt ? (
            <div className="muted" style={{ fontSize: 11 }}>
              Computed {fmtDate(computedAt)}
            </div>
          ) : null}
          <AccessibleChartData
            title="Inferred demographic confidence"
            summary={`${rows.length} inferred traits for the selected subscriber. Values are predictions from profile signals and are not self-reported.`}
            rowHeaderLabel="Inferred trait"
            columns={[
              { key: "value", label: "Predicted value" },
              { key: "confidence", label: "Confidence (fraction / percent)" },
              { key: "band", label: "Confidence band" },
              { key: "source", label: "Inference source" },
              { key: "computed", label: "Computed at" },
            ]}
            rows={rows.map((row) => {
              const confidence =
                typeof row.trait.confidence === "number" &&
                Number.isFinite(row.trait.confidence) &&
                row.trait.confidence >= 0 &&
                row.trait.confidence <= 1
                  ? row.trait.confidence
                  : null;
              return {
                key: row.label,
                label: row.label,
                values: {
                  value: demographicDisplayValue(row.trait.value),
                  confidence:
                    confidence == null
                      ? "Unavailable"
                      : `${confidence.toFixed(2)} (${Math.round(confidence * 100)}%)`,
                  band:
                    confidence == null
                      ? "Unavailable"
                      : demographicConfidenceBand(confidence).label,
                  source: row.trait.source || "Not supplied",
                  computed: row.trait.computed_at || "Not supplied",
                },
                exportValues: {
                  value: demographicDisplayValue(row.trait.value),
                  confidence,
                  band:
                    confidence == null
                      ? "Unavailable"
                      : demographicConfidenceBand(confidence).label,
                  source: row.trait.source || "",
                  computed: row.trait.computed_at || "",
                },
              };
            })}
            provenance={dux025Provenance("demographicsConfidence", {
              scope: `Subscriber ${subscriberId} · ${rows.length} inferred traits`,
              asOf: computedAt,
            })}
            exportFileName="subscriber-inferred-demographic-confidence.csv"
            exportPrivacy="confidential"
          />
        </div>
      )}
    </section>
  );
}
