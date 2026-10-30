/**
 * BlockedProductsBanner — the honest "why is this metric empty" surface
 * for reporting (Klaviyo-parity KLV-12).
 *
 * Some report metrics are `planned`/`partial` because they depend on a
 * not-yet-shipped product (flow runtime, deliverability routing, SMS/push,
 * reviews, helpdesk). Rather than render empty panes, the backend's
 * /api/v1/reporting/blocked-products groups those metrics by the gating
 * Klaviyo-parity initiative + a human note. This banner surfaces that
 * verbatim so an operator understands the gap instead of seeing a blank.
 *
 * It is purely informational: when there's nothing blocked (or the fetch
 * fails / lacks scope) it renders NOTHING — it must never block the page.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type BlockedProduct, reportingApi } from "../../lib/api-client";

/** Humanize a metric product_area key for display. Unknown keys title-case. */
function areaLabel(area: string): string {
  const map: Record<string, string> = {
    flow: "Flow",
    deliverability: "Deliverability",
    sms: "SMS",
    push: "Push",
    reviews: "Reviews",
    helpdesk: "Helpdesk",
  };
  const key = (area ?? "").toLowerCase();
  if (map[key]) return map[key];
  if (!area) return "Reporting";
  return area.charAt(0).toUpperCase() + area.slice(1);
}

/** "KLV-14-deliverability-routing-and-entitlements" → "KLV-14". The full
 *  slug is kept as a tooltip; the short code is the readable chip. */
function initiativeCode(initiative: string): string {
  const m = (initiative ?? "").match(/^(KLV-\d+)/i);
  return m ? m[1].toUpperCase() : (initiative ?? "");
}

export function BlockedProductsBanner(): ReactElement | null {
  const [items, setItems] = useState<BlockedProduct[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await reportingApi.blockedProducts();
      if (cancelled) return;
      // Non-critical + informational: any error (incl. 403 no-scope) just
      // means we render nothing. Never surface an error here.
      if (res.error || !res.data) {
        setItems([]);
        return;
      }
      setItems(Array.isArray(res.data.items) ? res.data.items : []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const blocked = Array.isArray(items) ? items : [];
  if (blocked.length === 0) return null; // nothing blocked, or not loaded yet

  return (
    <div
      className="card"
      style={{
        marginTop: 12,
        padding: "12px 14px",
        border: "1px solid var(--pw-border)",
        background: "var(--pw-bg-elev)",
        display: "grid",
        gap: 8,
      }}
    >
      <div className="section-title" style={{ marginBottom: 0, fontSize: 13 }}>
        Some reports are waiting on upcoming features
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        These metric areas aren&apos;t available yet — each is gated on a
        platform capability still in flight, not a data error.
      </div>
      {blocked.map((b, i) => {
        const metrics = Array.isArray(b.metrics) ? b.metrics : [];
        return (
          <div
            key={`${b.product_area ?? "area"}-${i}`}
            style={{
              borderTop: i === 0 ? undefined : "1px solid var(--pw-border)",
              paddingTop: i === 0 ? 0 : 8,
              display: "grid",
              gap: 4,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <strong style={{ fontSize: 12 }}>{areaLabel(b.product_area)}</strong>
              {b.initiative ? (
                <span
                  className="badge"
                  style={{ fontSize: 10 }}
                  title={b.initiative}
                >
                  {initiativeCode(b.initiative)}
                </span>
              ) : null}
            </div>
            {b.blocked_note ? (
              <div className="muted" style={{ fontSize: 12 }}>
                {b.blocked_note}
              </div>
            ) : null}
            {metrics.length > 0 ? (
              <div
                style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}
              >
                {metrics.map((m, mi) => (
                  <span
                    key={`${m}-${mi}`}
                    className="muted mono"
                    style={{
                      fontSize: 10,
                      border: "1px solid var(--pw-border)",
                      borderRadius: 4,
                      padding: "1px 5px",
                    }}
                  >
                    {m}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
