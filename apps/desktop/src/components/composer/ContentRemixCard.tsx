/**
 * ContentRemixCard — coverage item #15 (content_remix).
 *
 * POST /campaigns/{id}/remix derives cross-channel assets (web
 * teaser / SMS / social / podcast outline) from the campaign body and
 * returns them synchronously — currently template-driven server-side
 * (NOT LLM-backed), though the wrapper already carries the LLM budget
 * for when the backend grows a model path. We render exactly what
 * came back, grouped by channel, with copy-to-clipboard.
 */

import { type ReactElement, useId, useRef, useState } from "react";

import { type RemixResponse, contentRemixApi } from "../../lib/api-client";
import { writeClipboardText } from "../../lib/clipboard";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";

interface Props {
  campaignId: string | number;
  canMutate: boolean;
}

/** Mirrors normalizeChannels() defaults in content_remix.go. */
const CHANNELS = [
  { id: "web_teaser", label: "Web teaser" },
  { id: "sms", label: "SMS" },
  { id: "social", label: "Social" },
  { id: "podcast_outline", label: "Podcast outline" },
] as const;

function channelLabel(id: string): string {
  return CHANNELS.find((c) => c.id === id)?.label ?? id;
}

export function ContentRemixCard({
  campaignId,
  canMutate,
}: Props): ReactElement {
  const [selected, setSelected] = useState<string[]>(CHANNELS.map((c) => c.id));
  const [tone, setTone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<RemixResponse | null>(null);
  const remixDescriptionId = useId();
  const remixInFlightRef = useRef(false);

  const toggle = (id: string): void => {
    setSelected((cur) =>
      cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id],
    );
  };

  const remix = async (): Promise<void> => {
    if (!canMutate || selected.length === 0 || remixInFlightRef.current) return;
    remixInFlightRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      const res = await contentRemixApi.remix(campaignId, {
        channels: selected,
        tone: tone.trim() || undefined,
      });
      if (res.error) {
        setErr(res.error.message);
        return;
      }
      setResult(res.data);
      if (res.data.assets.length === 0) {
        toast.info("Remix produced no assets — is the campaign body empty?");
      }
    } catch {
      setErr(
        "The remix couldn't be generated. Check your connection and retry.",
      );
    } finally {
      remixInFlightRef.current = false;
      setBusy(false);
    }
  };

  const remixUnavailableReason = !canMutate
    ? "Viewer role can't generate remixes."
    : busy
      ? "A remix is already being generated."
      : selected.length === 0
        ? "Pick at least one channel before generating a remix."
        : null;

  const copy = async (text: string): Promise<void> => {
    const result = await writeClipboardText(text, {
      contentClass: "personal",
      label: "Remixed content",
    });
    if (result.ok) toast.success("Copied to clipboard");
    else toast.error(result.message);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <SectionHeader
        title="Content remix"
        description="Repurpose this campaign as cross-channel assets — derived from the body, ready to paste."
      />

      <div
        style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}
      >
        {CHANNELS.map((c) => {
          const on = selected.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              className="btn btn-sm"
              aria-pressed={on}
              onClick={() => toggle(c.id)}
              style={{
                background: on ? "var(--pw-fg)" : "transparent",
                color: on ? "var(--pw-bg)" : "var(--pw-fg-muted)",
                fontWeight: on ? 600 : 400,
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          className="input"
          aria-label="Tone (optional)"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          placeholder="Tone (optional) — e.g. playful"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void remix()}
          aria-disabled={remixUnavailableReason !== null || undefined}
          aria-describedby={remixDescriptionId}
          aria-busy={busy || undefined}
        >
          {busy ? "Generating…" : "Generate remix"}
        </button>
        <span id={remixDescriptionId} className="visually-hidden">
          {remixUnavailableReason ??
            "Generate template-derived assets for the selected channels."}
        </span>
      </div>

      {err ? (
        <Notice
          tone="danger"
          title="Remix failed"
          style={{ marginTop: 8 }}
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void remix()}
            >
              Retry
            </button>
          }
        >
          {err}
        </Notice>
      ) : null}

      {result && result.assets.length > 0 ? (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 11 }}>
            Generated {new Date(result.generated_at).toLocaleString()} ·
            template-derived from the campaign body — review before publishing.
          </div>
          {result.assets.map((asset, i) => (
            <div
              key={`${asset.channel}-${i}`}
              style={{
                border: "1px solid var(--pw-border)",
                borderRadius: 6,
                padding: 10,
                display: "grid",
                gap: 6,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="badge">{channelLabel(asset.channel)}</span>
                <span style={{ fontWeight: 600, fontSize: 12, flex: 1 }}>
                  {asset.title}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void copy(asset.body)}
                >
                  Copy
                </button>
              </div>
              <pre
                style={{
                  margin: 0,
                  fontSize: 11,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: "var(--pw-fg-muted)",
                  maxHeight: 160,
                  overflow: "auto",
                }}
              >
                {asset.body}
              </pre>
            </div>
          ))}
        </div>
      ) : result ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          No assets came back for the selected channels.
        </div>
      ) : null}
    </div>
  );
}
