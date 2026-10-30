/**
 * EmbedPreviewCard — renders the hosted form inside an iframe
 * right in the slideover so the operator can see exactly what
 * subscribers will see, plus a QR code that links to the same URL for
 * offline / print use cases.
 *
 * Both the iframe and the QR are rendered client-side. QR generation uses
 * the bundled encoder, so previewing a form never discloses its URL or the
 * operator's IP address to a third-party image service.
 *
 * The iframe is gated behind a "Show preview" toggle because rendering
 * the embedded HTML triggers a real network call to the public form
 * endpoint — when the form is unpublished, that responds with a 404
 * which would look noisy if we always rendered it.
 */

import { type ReactElement, useEffect, useId, useState } from "react";
import QRCode from "qrcode";

import { toast } from "../Toast";
import { writeClipboardText } from "../../lib/clipboard";

interface Props {
  /** Server-confirmed public URL the form is reachable at. The preview permits
   * scripts and form submission inside an opaque-origin sandbox; callers must
   * still validate the URL before rendering it. */
  publicUrl: string;
  /** Form status — disables the preview when archived. */
  status: string | undefined;
}

export function EmbedPreviewCard({ publicUrl, status }: Props): ReactElement {
  const [showPreview, setShowPreview] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrFailed, setQrFailed] = useState(false);
  const previewDescriptionId = useId();
  const archived = (status ?? "").toLowerCase() === "archived";

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl("");
    setQrFailed(false);
    void QRCode.toDataURL(publicUrl, { margin: 1, width: 160 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [publicUrl]);

  const copy = async (): Promise<void> => {
    const result = await writeClipboardText(publicUrl, {
      contentClass: "public",
      label: "Form URL",
    });
    if (result.ok) toast.success("URL copied");
    else toast.error(result.message);
  };

  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: 12,
        background: "var(--pw-bg-elev-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div
            className="muted"
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 4,
            }}
          >
            Preview
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--pw-fg-muted)",
              wordBreak: "break-all",
              marginBottom: 8,
            }}
          >
            {publicUrl}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void copy()}
            >
              Copy URL
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                if (archived) return;
                setShowPreview((v) => !v);
              }}
              aria-disabled={archived || undefined}
              aria-describedby={previewDescriptionId}
            >
              {showPreview ? "Hide live" : "Show live"}
            </button>
          </div>
          <p
            id={previewDescriptionId}
            className="muted"
            style={{ fontSize: 11, margin: "6px 0 0", lineHeight: 1.45 }}
          >
            {archived
              ? "Archived forms cannot be loaded from the public endpoint. Restore the form before opening a live preview."
              : "Loads the public form inline only when you request it."}
          </p>
        </div>
        <div style={{ flexShrink: 0 }}>
          <div
            className="muted"
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginBottom: 4,
            }}
          >
            QR
          </div>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={`QR code for ${publicUrl}`}
              width={120}
              height={120}
              style={{
                border: "1px solid var(--pw-border)",
                borderRadius: 4,
                // QR readers expect a true-white quiet zone. This is a
                // brand-independent contrast pair, not a themed surface.
                // eslint-disable-next-line no-restricted-syntax -- QR readers need true white
                background: "#fff",
                padding: 4,
                display: "block",
              }}
            />
          ) : (
            <div
              role="status"
              style={{
                display: "flex",
                width: 120,
                height: 120,
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                color: "var(--pw-fg-muted)",
                border: "1px dashed var(--pw-border)",
                borderRadius: 4,
                textAlign: "center",
                padding: 8,
              }}
            >
              {qrFailed ? "QR unavailable — use Copy URL" : "Generating QR…"}
            </div>
          )}
        </div>
      </div>
      {showPreview && !archived ? (
        <div style={{ marginTop: 12 }}>
          <iframe
            src={publicUrl}
            title="Form preview"
            sandbox="allow-forms allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
            style={{
              width: "100%",
              minHeight: 360,
              border: "1px solid var(--pw-border)",
              borderRadius: 4,
              background: "var(--pw-bg)",
            }}
          />
          <div
            className="muted"
            style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}
          >
            Loaded from the public endpoint. If the form is in draft mode this
            may render an error page until you publish.
          </div>
        </div>
      ) : null}
    </div>
  );
}
