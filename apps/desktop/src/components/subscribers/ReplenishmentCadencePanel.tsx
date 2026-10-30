/**
 * ReplenishmentCadencePanel — SUB-061 (expected date of next order) +
 * SUB-062 (average time between orders) replenishment-cadence signals.
 *
 * Reads GET /api/v1/subscribers/{id}/replenishment-cadence, which surfaces
 * three computed traits the commerce replenishment-cadence worker
 * maintains from order history:
 *   - average_days_between_orders — the rolling repeat-purchase cadence
 *     (SUB-062), rendered as a "Repeat purchase cadence: X days" card;
 *   - expected_next_order_at — the predictive timestamp of the next order
 *     (SUB-061 = last_order_at + average_days), rendered as an
 *     "Expected next order" card with a relative countdown;
 *   - last_order_at — context for the projection.
 * A `computed_at` recency stamp is shown beneath, mirroring
 * CatalogAttributesPanel.
 *
 * Self-contained (loads its own data, like CatalogAttributesPanel) so the
 * parent slideover's big Promise.all stays untouched. 404 (routes not
 * deployed) → the whole panel hides via onUnavailable, matching the
 * slideover's graceful-degradation convention.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type ReplenishmentCadence, api } from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";

interface Props {
  /** Subscriber UUID or email (the endpoint accepts both). */
  subscriberId: string;
  /** Fired when the replenishment-cadence routes are not deployed (404). */
  onUnavailable?: () => void;
}

/**
 * Compact relative phrasing for the expected-next-order date. Future ⇒
 * "in N days"; past ⇒ "N days ago" (the projection elapsed without a new
 * order); today ⇒ "today". Empty input ⇒ "".
 */
function relExpected(iso: string | null): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const days = Math.round((ts - Date.now()) / (24 * 60 * 60 * 1000));
  if (days === 0) return "today";
  if (days > 0) return days === 1 ? "in 1 day" : `in ${days} days`;
  const past = -days;
  return past === 1 ? "1 day ago" : `${past} days ago`;
}

/** One card in the cadence panel. */
function CadenceCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}): ReactElement {
  return (
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
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
      {sub ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

export function ReplenishmentCadencePanel({
  subscriberId,
  onUnavailable,
}: Props): ReactElement | null {
  const [data, setData] = useState<ReplenishmentCadence | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrMsg(null);
    setData(null);
    void (async () => {
      try {
        const res = await api.getSubscriberReplenishmentCadence(subscriberId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.error) {
          if (res.error.kind === "http" && res.error.status === 404) {
            onUnavailable?.();
            return;
          }
          setErrMsg("Replenishment cadence could not be loaded.");
          return;
        }
        setData(res.data);
      } catch {
        if (!controller.signal.aborted) {
          setErrMsg("Replenishment cadence could not be loaded.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce, subscriberId]);

  const rawAvg = data?.average_days_between_orders;
  const avg =
    typeof rawAvg === "number" && Number.isFinite(rawAvg) && rawAvg >= 0
      ? rawAvg
      : null;
  const rawExpected = data?.expected_next_order_at;
  const expected =
    typeof rawExpected === "string" && Number.isFinite(Date.parse(rawExpected))
      ? rawExpected
      : null;
  const hasAny = avg != null || expected != null;

  if (loading) {
    return (
      <section>
        <div className="label">Replenishment cadence</div>
        <div className="skel" style={{ height: 64 }} />
      </section>
    );
  }

  return (
    <section>
      <div className="label">Replenishment cadence</div>
      {errMsg ? (
        <div role="alert" style={{ fontSize: 12 }}>
          <span className="muted">{errMsg}</span>
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setReloadNonce((current) => current + 1)}
            >
              Retry cadence
            </button>
          </div>
        </div>
      ) : !hasAny ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No repeat-purchase data yet — cadence and next-order prediction are
          computed from order history.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* SUB-062 — average days between orders. */}
          {avg != null ? (
            <CadenceCard
              label="Repeat purchase cadence"
              value={`${avg % 1 === 0 ? avg : avg.toFixed(1)} days`}
              sub="Average time between orders"
            />
          ) : null}

          {/* SUB-061 — expected date of next order. */}
          {expected != null ? (
            <CadenceCard
              label="Expected next order"
              value={fmtDate(expected)}
              sub={relExpected(expected) || undefined}
            />
          ) : null}

          {data?.last_order_at &&
          Number.isFinite(Date.parse(data.last_order_at)) ? (
            <div className="muted" style={{ fontSize: 11 }}>
              Last order {fmtDate(data.last_order_at)}
            </div>
          ) : null}

          {data?.computed_at &&
          Number.isFinite(Date.parse(data.computed_at)) ? (
            <div className="muted" style={{ fontSize: 11 }}>
              Computed {fmtDate(data.computed_at)}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
