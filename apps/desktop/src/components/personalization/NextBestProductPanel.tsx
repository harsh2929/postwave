// NextBestProductPanel — surfaces the item-item CF recommender (apps/api/internal/nbp)
// for one subscriber. The engine (builder worker + /api/v1/nbp/recommend) was
// mounted and running with no UI consumer (G-26/G-54); this is that consumer.
import { useEffect, useState } from "react";

import { nextBestProductApi } from "../../lib/api-client";
import type { NbpRecommendation } from "../../lib/api/next-best-product";

type PanelState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: NbpRecommendation[]; helper: string };

function priceLabel(rec: NbpRecommendation): string {
  if (rec.price_cents == null) return "";
  const amount = (rec.price_cents / 100).toFixed(2);
  return rec.currency ? `${amount} ${rec.currency}` : amount;
}

export function NextBestProductPanel({ subscriberId }: { subscriberId: string }) {
  const [state, setState] = useState<PanelState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    nextBestProductApi
      .recommend(subscriberId, 6)
      .then((res) => {
        if (!alive) return;
        if (res.error) {
          setState({ status: "error", message: res.error.message });
        } else {
          setState({ status: "ready", items: res.data.items, helper: res.data.helper_name });
        }
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [subscriberId]);

  return (
    <section aria-label="Next best product recommendations" style={{ display: "grid", gap: "0.75rem" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Next best products</h3>
        {state.status === "ready" ? (
          <span style={{ color: "var(--pw-fg-muted)", fontSize: "0.8rem" }}>
            {state.items.length} for this subscriber
          </span>
        ) : null}
      </header>

      {state.status === "loading" ? (
        <p style={{ color: "var(--pw-fg-muted)" }}>Loading recommendations…</p>
      ) : null}

      {state.status === "error" ? (
        <p role="alert" style={{ color: "var(--pw-danger)" }}>
          Could not load recommendations: {state.message}
        </p>
      ) : null}

      {state.status === "ready" && state.items.length === 0 ? (
        <p style={{ color: "var(--pw-fg-muted)" }}>
          No recommendations yet — the recommender needs more purchase history for this subscriber.
        </p>
      ) : null}

      {state.status === "ready" && state.items.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}>
          {state.items.map((rec) => (
            <li
              key={rec.product_id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                border: "1px solid var(--pw-border)",
                borderRadius: 8,
                padding: "0.5rem 0.75rem",
              }}
            >
              {rec.image_url ? (
                <img
                  src={rec.image_url}
                  alt=""
                  width={40}
                  height={40}
                  style={{ borderRadius: 6, objectFit: "cover", flex: "0 0 auto" }}
                />
              ) : null}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {rec.title || rec.product_id}
                </div>
                <div style={{ color: "var(--pw-fg-muted)", fontSize: "0.8rem" }}>
                  <span title="recommendation strategy">{rec.strategy}</span>
                  {priceLabel(rec) ? <> · {priceLabel(rec)}</> : null}
                  {rec.anchors && rec.anchors.length > 0 ? (
                    <> · because they bought {rec.anchors.length} related item{rec.anchors.length === 1 ? "" : "s"}</>
                  ) : null}
                </div>
              </div>
              <span
                title="recommendation score"
                style={{ color: "var(--pw-fg-subtle)", fontVariantNumeric: "tabular-nums", fontSize: "0.85rem" }}
              >
                {rec.score.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {state.status === "ready" && state.helper ? (
        <p style={{ color: "var(--pw-fg-subtle)", fontSize: "0.75rem", margin: 0 }}>
          Render in an email with <code>{`{{ ${state.helper} }}`}</code>.
        </p>
      ) : null}
    </section>
  );
}
