/**
 * CrossClientPreview (G8 of the campaigns 2026 pack)
 *
 * "Preview across clients" — renders the campaign body across the
 * 10-environment CSS-emulation matrix (Gmail web/iOS, Apple Mail
 * macOS/iOS, Outlook web/Windows, Yahoo, dark mode) via POST
 * /api/v1/render and shows a screenshot tile per client with any
 * per-environment rendering issues.
 *
 * Rendering is paid (HCTI) and slow, so it's gated behind an explicit
 * "Render previews" button rather than firing on mount.
 */

import { type ReactElement, useState } from "react";

import { type CrossClientRender, api } from "../lib/api-client";
import { toast } from "./Toast";

interface Props {
  /** The HTML body to render across clients. */
  body: string;
}

export function CrossClientPreview({ body }: Props): ReactElement {
  const [renders, setRenders] = useState<CrossClientRender[] | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (): Promise<void> => {
    if (!body.trim()) {
      toast.error("Add some body content first.");
      return;
    }
    setLoading(true);
    const res = await api.renderAcrossClients({ html: body });
    setLoading(false);
    if (res.error) {
      toast.error(`Couldn't render previews: ${res.error.message}`);
      return;
    }
    setRenders(res.data.renders);
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}
      >
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void run()}
          disabled={loading}
        >
          {loading
            ? "Rendering…"
            : renders
              ? "Re-render across clients"
              : "Render across clients"}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          Screenshots across Gmail, Apple Mail, Outlook, Yahoo + dark mode
        </span>
      </div>

      {renders ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          {renders.map((r) => (
            <div
              key={r.environment.name}
              style={{
                border: "1px solid var(--pw-border)",
                borderRadius: 6,
                overflow: "hidden",
                background: r.environment.dark_mode
                  ? "var(--pw-bg)"
                  : "var(--pw-email-canvas)",
              }}
            >
              <div
                style={{
                  padding: "4px 8px",
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "var(--pw-bg-elev)",
                  color: "var(--pw-fg)",
                }}
              >
                <span style={{ fontWeight: 600 }}>{r.environment.name}</span>
                {r.environment.dark_mode ? (
                  <span className="badge" style={{ fontSize: 9 }}>
                    dark
                  </span>
                ) : null}
                {r.issues.length > 0 ? (
                  <span
                    className="badge warning"
                    style={{ fontSize: 9, marginLeft: "auto" }}
                    title={r.issues.join("\n")}
                  >
                    {r.issues.length} issue{r.issues.length === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
              {r.image_url ? (
                <img
                  src={r.image_url}
                  alt={`${r.environment.name} preview`}
                  loading="lazy"
                  style={{ width: "100%", display: "block" }}
                />
              ) : (
                <div
                  className="muted"
                  style={{ padding: 12, fontSize: 11 }}
                  title={r.issues.join("\n")}
                >
                  No image — {r.issues[0] ?? "render unavailable"}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
