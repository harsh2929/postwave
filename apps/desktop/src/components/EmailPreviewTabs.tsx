/**
 * EmailPreviewTabs — renders the four client previews (Gmail / Outlook /
 * Apple / Dark) returned by `POST /api/v1/email-preview/render`.
 *
 * Drop this inside a parent that already gives the user an "Edit" tab; the
 * parent's textarea stays visible there. THIS component only renders the
 * "Preview" panel — the tab strip *between* clients is internal here.
 *
 * Implementation notes:
 *   - The body field across the app is HTML (not MJML). The Phase-10
 *     backend takes an `mjml` field and:
 *       (a) tries the `mjml` CLI first, which understands real MJML
 *       (b) falls back to a stub renderer that passes the input through
 *           if the CLI is missing.
 *     So plain HTML works fine — it travels through the stub and we get
 *     per-client approximations downstream. Authors who paste real MJML
 *     get a proper render when the CLI is installed on the API host.
 *   - Iframes are sandboxed with `allow-same-origin` ONLY (no scripts).
 *     Email body content can include arbitrary inline JS we never want
 *     to execute. `srcDoc` keeps the network footprint at zero.
 *   - We debounce body changes by 500ms before re-fetching — typing
 *     30 chars/sec shouldn't generate 30 API calls.
 *   - The previous preview stays on screen during reload (a thin progress
 *     bar at the top signals "we're refreshing"); avoids flash-to-blank.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type EmailPreviewResponse,
  type ProductRecommendation,
  api,
  apiSendTimeAssets,
} from "../lib/api-client";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { useRemoteResource } from "../hooks/useRemoteResource";
import { remoteFailureFromError } from "../lib/remote-resource";

type ClientId = "gmail" | "outlook" | "apple" | "dark" | "recommendations";

interface ClientSpec {
  id: ClientId;
  label: string;
  /** Width of the iframe wrapper in CSS pixels (matches the client viewport). */
  width: number;
}

const CLIENTS: ClientSpec[] = [
  { id: "gmail", label: "Gmail", width: 600 },
  { id: "outlook", label: "Outlook", width: 580 },
  { id: "apple", label: "Apple Mail", width: 375 },
  { id: "dark", label: "Dark mode", width: 600 },
  // Workstream 4 (Mailchimp parity polish): compose-time recommendations
  // preview. The "Recommendations" tab swaps the iframe for a card grid
  // built off the /api/v1/commerce/recommendations endpoint.
  { id: "recommendations", label: "Recommendations", width: 600 },
];

const IFRAME_HEIGHT = 480;
const DEBOUNCE_MS = 500;
const PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; frame-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'";

export function isolatedPreviewDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${meta}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(
      /<html(?:\s[^>]*)?>/i,
      (root) => `${root}<head>${meta}</head>`,
    );
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

interface Props {
  /** Email body — HTML or MJML — passed straight to the API as `mjml`. */
  body: string;
  /** Optional template variables for `{{name}}` style substitutions. */
  vars?: Record<string, string>;
}

export function EmailPreviewTabs({ body, vars }: Props): ReactElement {
  const [active, setActive] = useState<ClientId>("gmail");
  const [preview, setPreview] = useState<EmailPreviewResponse | null>(null);
  const [verifiedInputKey, setVerifiedInputKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tabs = useTabsInteraction({
    activation: "manual",
    value: active,
    items: CLIENTS.map((client) => ({ value: client.id })),
    onChange: setActive,
  });
  /**
   * Tracks the most recent fetch invocation. We use a token rather than
   * AbortController because the client lib doesn't surface abort — but
   * the closed-over token guarantees stale responses can't clobber a
   * newer one if the user types fast.
   */
  const reqIdRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const flightRef = useRef<{
    inputKey: string;
    promise: Promise<void>;
  } | null>(null);
  const varsKey = useMemo(
    () =>
      JSON.stringify(
        Object.entries(vars ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    [vars],
  );

  const fetchPreview = useCallback(
    async (b: string): Promise<void> => {
      const inputKey = `${b}\u0000${varsKey}`;
      if (!b.trim()) {
        reqIdRef.current += 1;
        flightRef.current = null;
        setPreview(null);
        setVerifiedInputKey(null);
        setErr(null);
        setLoading(false);
        return;
      }
      if (flightRef.current?.inputKey === inputKey) {
        return flightRef.current.promise;
      }
      const myId = ++reqIdRef.current;
      setLoading(true);
      setErr(null);
      const request = (async (): Promise<void> => {
        try {
          const response = await Promise.resolve().then(() =>
            api.renderEmailPreview({ mjml: b, vars }),
          );
          if (!mountedRef.current || myId !== reqIdRef.current) return;
          if (response.error) {
            setErr(remoteFailureFromError(response.error).message);
            return;
          }
          setPreview(response.data);
          setVerifiedInputKey(inputKey);
        } catch {
          if (!mountedRef.current || myId !== reqIdRef.current) return;
          setErr(remoteFailureFromError({ kind: "network" }).message);
        } finally {
          if (mountedRef.current && myId === reqIdRef.current) {
            setLoading(false);
          }
        }
      })();
      flightRef.current = { inputKey, promise: request };
      try {
        await request;
      } finally {
        if (flightRef.current?.promise === request) flightRef.current = null;
      }
    },
    [vars, varsKey],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reqIdRef.current += 1;
      flightRef.current = null;
    };
  }, []);

  // Debounced effect on body change. We deliberately keep `vars` out of the
  // dep array — vars are usually stable; if a caller hot-swaps them, the
  // closure already captured the latest pointer through `fetchPreview`.
  useEffect(() => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      void fetchPreview(body);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [body, fetchPreview]);

  const refresh = (): void => {
    void fetchPreview(body);
  };

  /* ---------- empty state -------------------------------------------- */
  // Workstream 4 (Mailchimp parity polish): the Recommendations tab
  // renders even when the body is empty — it's anchored on subscriber
  // data, not the draft body. So the empty-body state must NOT early
  // return here: the tab strip below stays mounted (otherwise the
  // Recommendations tab is unreachable) and the empty hint renders in
  // place of the iframe stage instead.
  const emptyBody = !body.trim();

  const activeSpec = CLIENTS.find((c) => c.id === active) ?? CLIENTS[0]!;
  // The previews map is keyed only on the four email-client ids; the
  // Recommendations tab (Workstream 4) ignores `html` and renders its
  // own card grid, so a lookup miss is fine here.
  const html =
    active === "recommendations"
      ? ""
      : (preview?.previews?.[
          active as "gmail" | "outlook" | "apple" | "dark"
        ] ?? "");
  const isolatedHtml = useMemo(() => isolatedPreviewDocument(html), [html]);
  const currentInputKey = `${body}\u0000${varsKey}`;
  const showingOlderDraft =
    preview !== null &&
    verifiedInputKey !== null &&
    verifiedInputKey !== currentInputKey;
  const warnings = preview?.warnings ?? [];

  return (
    <div className="email-preview-host">
      {/* Top bar: client tabs + refresh button */}
      <div className="email-preview-toolbar">
        <div
          ref={tabs.listRef}
          className="tabs email-preview-tabs"
          {...tabs.listProps}
          aria-label="Email preview client"
        >
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              {...tabs.getTabProps(c.id)}
              className={`tab${active === c.id ? " is-active" : ""}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {active !== "recommendations" ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={refresh}
            aria-disabled={loading || undefined}
            aria-busy={loading || undefined}
            aria-label={`Refresh ${activeSpec.label} preview`}
          >
            {loading ? "Refreshing…" : "Refresh preview"}
          </button>
        ) : null}
      </div>

      {/* Loading bar — visible during reload, even if preview is stale */}
      {loading ? (
        <div
          className="email-preview-progress"
          role="status"
          aria-label="Refreshing email-client previews"
        />
      ) : null}
      {showingOlderDraft && !err ? (
        <div className="muted" role="status" style={{ marginBottom: 8 }}>
          The draft changed; showing the last verified preview while the new
          render is prepared.
        </div>
      ) : null}

      {/* Inline error during a refresh — we still keep the stale preview */}
      {err ? (
        <div className="notice" role="alert" style={{ marginBottom: 8 }}>
          <span>
            {showingOlderDraft
              ? "Render failed; showing the last verified preview for an older draft"
              : preview
                ? "Refresh failed; showing the last verified preview"
                : "Couldn't render preview"}
            : {err}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}

      {/* Warnings banner */}
      {warnings.length > 0 ? (
        <div className="email-preview-warning">
          <strong>Renderer notes:</strong>
          <ul>
            {warnings.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Fallback-renderer notice — the server couldn't run its engine
       *  or the mjml CLI and passed the body through unprocessed, so
       *  the per-client panes are NOT real renders. engine/mjml need
       *  no badge; only the degraded path gets called out. */}
      {preview?.renderer === "fallback" && active !== "recommendations" ? (
        <div className="email-preview-warning">
          Server renderer unavailable — showing unprocessed body.
          {preview.warning ? ` (${preview.warning})` : ""}
        </div>
      ) : null}

      {/* Iframe stage — width matches the client's typical viewport.
       *  Workstream 4: when the operator picks the "Recommendations"
       *  tab we render the compose-time recommendation cards instead
       *  of an iframe; the rest of the toolbar (refresh / warnings) is
       *  reused as-is so the surface chrome stays consistent. */}
      {CLIENTS.map((client) => (
        <section key={client.id} {...tabs.getPanelProps(client.id)}>
          {active !== client.id ? null : client.id === "recommendations" ? (
            <RecommendationsPreview />
          ) : emptyBody ? (
            <div className="email-preview-empty muted">
              Type something to see the preview.
            </div>
          ) : (
            <div className="email-preview-frame">
              <iframe
                key={active /* re-mount on tab switch so srcDoc reflows */}
                className="email-preview-iframe"
                title={`${activeSpec.label} preview`}
                // Unique-origin sandbox with no capabilities. The injected
                // CSP also blocks remote pixels, fonts, stylesheets, frames,
                // forms, media, scripts, and network connections.
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={isolatedHtml}
                style={{
                  width: activeSpec.width,
                  height: IFRAME_HEIGHT,
                }}
              />
            </div>
          )}
        </section>
      ))}

      <div className="email-preview-disclaimer muted">
        Approximations based on documented client quirks; not pixel-perfect.
      </div>
    </div>
  );
}

/* ---------- recommendations tab (Workstream 4) ----------------------- */

export function safeProductImageUrl(
  value: string | null | undefined,
): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function formatProductPrice(
  priceCents: number,
  currency: string | null | undefined,
): string {
  const rawCurrency = currency?.trim().toUpperCase() ?? "";
  const normalizedCurrency = /^[A-Z]{3}$/.test(rawCurrency)
    ? rawCurrency
    : "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency,
    }).format(priceCents / 100);
  } catch {
    return `${(priceCents / 100).toFixed(2)} ${normalizedCurrency}`;
  }
}

/**
 * Workstream 4 (Mailchimp parity polish): compose-time product
 * recommendations preview.
 *
 * Renders the deterministic ranking returned by
 * /api/v1/commerce/recommendations against an operator-chosen anchor
 * subscriber. The dropdown ships with a few synthetic anchors so the
 * preview works even on tenants that haven't connected a store yet
 * (the endpoint returns an empty list in that case).
 */
function RecommendationsPreview(): ReactElement {
  const [subscriberId, setSubscriberId] = useState<string>("");
  const retryFlightRef = useRef<Promise<void> | null>(null);
  const recommendations = useRemoteResource<ProductRecommendation[]>(
    async () => {
      const response = await apiSendTimeAssets.getProductRecommendations({
        subscriberId: subscriberId || undefined,
        limit: 8,
      });
      return response.error
        ? { error: response.error }
        : { data: response.data?.items ?? [] };
    },
    { identity: `recommendations:${subscriberId || "popularity"}` },
  );
  const items = recommendations.data;
  const loading = recommendations.transport === "loading";
  const retry = (): void => {
    if (retryFlightRef.current) return;
    const request = recommendations.reload();
    retryFlightRef.current = request;
    void request.finally(() => {
      if (retryFlightRef.current === request) retryFlightRef.current = null;
    });
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <label htmlFor="rec-anchor" className="muted" style={{ fontSize: 12 }}>
          Anchor subscriber
        </label>
        <select
          id="rec-anchor"
          className="input"
          value={subscriberId}
          onChange={(e) => setSubscriberId(e.target.value)}
          style={{ width: "auto", minWidth: 220 }}
        >
          <option value="">(no anchor — popularity only)</option>
          <option value="sample-vip">Sample · VIP / repeat buyer</option>
          <option value="sample-new">Sample · new subscriber</option>
          <option value="sample-cart">Sample · abandoned cart</option>
        </select>
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={loading || undefined}
          aria-busy={loading || undefined}
          onClick={retry}
        >
          {loading ? "Refreshing…" : "Refresh recommendations"}
        </button>
      </div>
      {recommendations.failure ? (
        <div className="notice" role="alert">
          <span>
            Couldn&apos;t verify recommendations:{" "}
            {recommendations.failure.message}
            {recommendations.stale
              ? " The last verified recommendations remain visible below."
              : ""}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={loading || undefined}
            aria-busy={loading || undefined}
            onClick={retry}
          >
            {loading ? "Retrying…" : "Retry recommendations"}
          </button>
        </div>
      ) : null}
      {loading && items === null ? (
        <div className="muted" role="status" style={{ fontSize: 12 }}>
          Loading recommendations…
        </div>
      ) : null}
      {loading && items !== null ? (
        <div className="muted" role="status" style={{ fontSize: 12 }}>
          Refreshing recommendations; showing the last verified ranking.
        </div>
      ) : null}
      {items && items.length === 0 && !loading && !recommendations.failure ? (
        <div className="empty-state">
          <div className="empty-state-icon" aria-hidden="true">
            ·
          </div>
          <h3>No products to recommend</h3>
          <p>
            Connect a Shopify or WooCommerce store and sync your catalog to
            power this preview.
          </p>
        </div>
      ) : null}
      {items && items.length > 0 ? (
        <div
          className="card-grid"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          }}
        >
          {items.map((p) => (
            <div
              key={p.product_id}
              className="card"
              style={{ padding: 8, display: "grid", gap: 6 }}
            >
              {safeProductImageUrl(p.image_url) ? (
                <img
                  src={safeProductImageUrl(p.image_url)}
                  alt={p.title}
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  style={{
                    width: "100%",
                    height: 120,
                    objectFit: "cover",
                    borderRadius: 4,
                    background:
                      "color-mix(in srgb, var(--pw-fg) 4%, transparent)",
                  }}
                />
              ) : (
                <div
                  style={{
                    width: "100%",
                    height: 120,
                    borderRadius: 4,
                    background:
                      "color-mix(in srgb, var(--pw-fg) 4%, transparent)",
                  }}
                />
              )}
              <div
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  overflowWrap: "anywhere",
                }}
              >
                {p.title}
              </div>
              <div className="row" style={{ gap: 4, alignItems: "center" }}>
                <span style={{ fontSize: 12 }}>
                  {formatProductPrice(p.price_cents, p.currency)}
                </span>
                <span className="spacer" />
                <span className="badge">
                  Recommendation score {p.score.toFixed(2)}
                </span>
              </div>
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  overflowWrap: "anywhere",
                }}
              >
                {p.reason}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
