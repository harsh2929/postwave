/**
 * CatalogAttributesPanel — SUB-013 catalog-linked profile attributes.
 *
 * Reads GET /api/v1/subscribers/{id}/catalog-attributes (two computed
 * traits: favorite_category + last_viewed_sku, materialized by the
 * commerce/catalog_attributes worker). Renders, inline in the Profile
 * tab:
 *   - a Favorite Category card with the top category + a frequency
 *     bar (the backend stores {category, count, timestamp}); when the
 *     value carries a `top` array we render up to 3 bars as a small
 *     histogram, otherwise the single computed category;
 *   - a Last Viewed SKU card with the SKU string + recency timestamp.
 *
 * Self-contained (loads its own data, like RatingView) so the parent
 * slideover's big Promise.all stays untouched. 404 (routes not mounted)
 * → the whole panel hides via onUnavailable, matching the slideover's
 * graceful-degradation convention.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import {
  type CatalogAttributes,
  type FavoriteCategoryValue,
  api,
} from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";

interface Props {
  /** Subscriber UUID or email (the endpoint accepts both). */
  subscriberId: string;
  /** Fired when the catalog-attributes routes are not deployed (404). */
  onUnavailable?: () => void;
}

/** One bar in the favorite-category histogram. */
interface CategoryBar {
  category: string;
  count: number;
}

/**
 * Coerces the raw favorite_category trait value into up to three bars.
 * The canonical shape is {category, count, timestamp}; some workers also
 * emit a `top: [{category, count}, ...]` array, which we prefer when
 * present so the histogram can show the real distribution.
 */
function favoriteCategoryBars(v: FavoriteCategoryValue | null): CategoryBar[] {
  if (!v || typeof v !== "object") return [];
  const withTop = v as FavoriteCategoryValue & {
    top?: Array<{ category?: unknown; count?: unknown }>;
  };
  if (Array.isArray(withTop.top) && withTop.top.length > 0) {
    return withTop.top
      .map((row) => ({
        category: String(row.category ?? "").trim(),
        count:
          Number.isFinite(Number(row.count)) && Number(row.count) >= 0
            ? Number(row.count)
            : 0,
      }))
      .filter((row) => row.category !== "")
      .slice(0, 3);
  }
  const category = String(v.category ?? "").trim();
  if (category === "") return [];
  const count = Number(v.count);
  return [
    {
      category,
      count: Number.isFinite(count) && count >= 0 ? count : 0,
    },
  ];
}

export function CatalogAttributesPanel({
  subscriberId,
  onUnavailable,
}: Props): ReactElement | null {
  const [data, setData] = useState<CatalogAttributes | null>(null);
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
        const res = await api.getSubscriberCatalogAttributes(subscriberId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.error) {
          if (res.error.kind === "http" && res.error.status === 404) {
            onUnavailable?.();
            return;
          }
          setErrMsg("Catalog attributes could not be loaded.");
          return;
        }
        setData(res.data);
      } catch (requestError) {
        void requestError;
        if (controller.signal.aborted) return;
        setErrMsg("Catalog attributes could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriberId, reloadKey]);

  const bars = useMemo(
    () => favoriteCategoryBars(data?.favorite_category ?? null),
    [data],
  );
  const maxCount = useMemo(
    () => bars.reduce((m, b) => Math.max(m, b.count), 0),
    [bars],
  );

  const lastSku = (data?.last_viewed_sku ?? "").trim();
  const hasAny = bars.length > 0 || lastSku !== "";

  if (loading) {
    return (
      <section role="status" aria-label="Loading catalog attributes">
        <div className="label">Catalog attributes</div>
        <div className="skel" style={{ height: 64 }} aria-hidden="true" />
      </section>
    );
  }

  return (
    <section>
      <div className="label">Catalog attributes</div>
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
      ) : !hasAny ? (
        <div className="muted" style={{ fontSize: 12 }} role="status">
          No catalog activity yet — favorite category and last viewed SKU are
          computed from commerce events.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Favorite Category histogram (top 3). */}
          {bars.length > 0 ? (
            <div
              style={{
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
                padding: "8px 10px",
              }}
            >
              <div
                className="muted"
                style={{ fontSize: 11, marginBottom: 6, fontWeight: 600 }}
              >
                Favorite category
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {bars.map((bar) => {
                  const pct =
                    maxCount > 0
                      ? Math.max(6, Math.round((bar.count / maxCount) * 100))
                      : 6;
                  return (
                    <div key={bar.category}>
                      <div
                        aria-hidden="true"
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 12,
                          marginBottom: 2,
                        }}
                      >
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={bar.category}
                        >
                          {bar.category}
                        </span>
                        <span className="muted tabular">{bar.count}</span>
                      </div>
                      <div
                        style={{
                          height: 6,
                          borderRadius: 3,
                          background: "var(--pw-bg)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${pct}%`,
                            background: "var(--pw-accent)",
                            backgroundImage:
                              "repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--pw-bg) 45%, transparent) 3px 4px)",
                            borderRadius: 3,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Last Viewed SKU card. */}
          {lastSku !== "" ? (
            <div
              style={{
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
                padding: "8px 10px",
              }}
            >
              <div
                className="muted"
                style={{ fontSize: 11, marginBottom: 4, fontWeight: 600 }}
              >
                Last viewed SKU
              </div>
              <div
                style={{
                  fontFamily: "var(--pw-font-mono)",
                  fontSize: 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={lastSku}
              >
                {lastSku}
              </div>
            </div>
          ) : null}

          {data?.computed_at ? (
            <div className="muted" style={{ fontSize: 11 }}>
              Computed {fmtDate(data.computed_at)}
            </div>
          ) : null}
          {bars.length > 0 ? (
            <AccessibleChartData
              title="Favorite-category event frequency"
              summary={`${bars.length} returned favorite categories for the selected subscriber. Bar widths are relative to the largest returned count and are not shares of all catalog activity.`}
              rowHeaderLabel="Category"
              columns={[
                { key: "events", label: "Observed events" },
                {
                  key: "relative",
                  label: "Relative to displayed maximum (%)",
                },
              ]}
              rows={bars.map((bar) => ({
                key: bar.category,
                label: bar.category,
                values: {
                  events: bar.count.toLocaleString(),
                  relative:
                    maxCount > 0
                      ? `${((bar.count / maxCount) * 100).toFixed(1)}%`
                      : "Unavailable",
                },
                exportValues: {
                  events: bar.count,
                  relative: maxCount > 0 ? (bar.count / maxCount) * 100 : null,
                },
              }))}
              provenance={dux025Provenance("catalogFavoriteCategories", {
                scope: `Subscriber ${subscriberId} · ${bars.length} returned categories`,
                asOf:
                  data?.computed_at ??
                  data?.favorite_category?.timestamp ??
                  null,
              })}
              exportFileName="subscriber-favorite-category-frequency.csv"
              exportPrivacy="confidential"
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
