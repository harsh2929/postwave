/**
 * PreviewAsSubscriber (G22 of the campaigns 2026 pack)
 *
 * Search any subscriber and render the campaign body exactly as they'd
 * receive it — merge tags, {% if %} conditionals, and dynamic regions
 * all resolved for that subscriber's real fields (server-side via
 * POST /campaigns/{id}/preview-as). Until now the Preview tab rendered
 * raw {{merge}} syntax.
 *
 * The rendered HTML is shown in a sandboxed iframe (no scripts, no
 * same-origin) so subscriber-controlled field values can't execute.
 */

import { type ReactElement, useEffect, useState } from "react";

import { type Subscriber, api } from "../lib/api-client";
import { toast } from "./Toast";

interface Props {
  campaignId: string | number;
}

export function PreviewAsSubscriber({ campaignId }: Props): ReactElement {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Subscriber[]>([]);
  const [searching, setSearching] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);

  // Debounced subscriber search.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const res = await api.listSubscribers({ query: q, perPage: 8 });
        if (cancelled) return;
        setSearching(false);
        if (res.error) return;
        setResults(
          res.data.items ?? res.data.data ?? res.data.results ?? [],
        );
      })();
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const renderAs = async (sub: Subscriber): Promise<void> => {
    setRendering(true);
    setResults([]);
    setQuery(sub.email ?? "");
    const res = await api.previewCampaignAsSubscriber(campaignId, {
      subscriber_id: sub.id != null ? String(sub.id) : undefined,
      subscriber_email: sub.email,
    });
    setRendering(false);
    if (res.error) {
      toast.error(`Couldn't render preview: ${res.error.message}`);
      return;
    }
    setHtml(res.data.body_html);
    setWho(res.data.subscriber_email);
    setUnresolved(res.data.unresolved_regions ?? []);
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ position: "relative", maxWidth: 360 }}>
        <input
          type="text"
          className="input"
          placeholder="Preview as… search a subscriber by email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {results.length > 0 ? (
          <div
            style={{
              position: "absolute",
              zIndex: 5,
              left: 0,
              right: 0,
              background: "var(--pw-bg-elev)",
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
              marginTop: 2,
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {results.map((s) => (
              <button
                key={String(s.id ?? s.email)}
                type="button"
                className="btn btn-ghost"
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  fontSize: 12,
                }}
                onClick={() => void renderAs(s)}
              >
                {s.email}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {searching ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Searching…
        </div>
      ) : null}

      {rendering ? (
        <div className="skel" style={{ height: 120, marginTop: 8 }} />
      ) : html != null ? (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
            Rendered for <span className="mono">{who}</span>
            {unresolved.length > 0 ? (
              <span
                className="badge warning"
                style={{ marginLeft: 6, fontSize: 9 }}
                title={`These region keys (e.g. segment membership) couldn't be evaluated and used the default branch: ${unresolved.join(", ")}`}
              >
                {unresolved.length} approximated region
                {unresolved.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <iframe
            title={`Preview for ${who}`}
            sandbox=""
            srcDoc={html}
            style={{
              width: "100%",
              height: 360,
              border: "1px solid var(--pw-border)",
              borderRadius: 6,
              background: "var(--pw-email-canvas)",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
