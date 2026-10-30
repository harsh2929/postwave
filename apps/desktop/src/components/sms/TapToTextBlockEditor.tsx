/**
 * TapToTextBlockEditor — generates a tap-to-text intent URL for use in
 * email/web/print campaigns. Mirrors Klaviyo's "Tap to text" block
 * (GAP-LS-148).
 *
 * The output is a local `sms:` URI with a reviewed short code/E.164
 * destination and pre-populated body. Device hand-off behavior varies.
 *
 * Link, HTML, and QR generation stay on-device. The short code and message
 * never leave the renderer merely to produce a preview or download.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

import { FormField } from "../FormField";
import { toast } from "../Toast";
import { writeClipboardText } from "../../lib/clipboard";
import { saveFile } from "../../lib/file-transfer";

/**
 * Canonicalize only explicitly reviewed ASCII display separators. Unknown
 * characters are rejected instead of silently changing recipient identity.
 */
export function parseSmsDestination(value: string): string | null {
  if (value.length === 0 || value.length > 32) return null;
  const trimmed = value.replace(/^ +| +$/gu, "");
  if (trimmed.length === 0 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(trimmed)) {
    return null;
  }
  if (/^[0-9]{5,6}$/u.test(trimmed)) return trimmed;
  if (!/^\+[0-9 ().-]+[0-9]$/u.test(trimmed)) return null;
  const digits = trimmed.slice(1).replace(/[ ().-]/gu, "");
  return /^[1-9][0-9]{6,14}$/u.test(digits) ? `+${digits}` : null;
}

function isSafeLocalCreativeText(
  value: string,
  maxScalars: number,
  allowEmpty: boolean,
): boolean {
  if (
    value.trim() !== value ||
    (!allowEmpty && value === "") ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  ) {
    return false;
  }
  return (
    Array.from(value).length <= maxScalars &&
    new TextEncoder().encode(value).byteLength <= maxScalars * 4
  );
}

export function buildSmsUri(shortCode: string, body: string): string {
  const destination = parseSmsDestination(shortCode);
  if (!destination || !isSafeLocalCreativeText(body, 40, true)) return "";
  // RFC 5724: sms:<number>?body=<text>
  // We URL-encode the body but preserve spaces as %20 (not '+') so
  // every native SMS app renders the keyword cleanly.
  try {
    const encoded = encodeURIComponent(body);
    return body ? `sms:${destination}?body=${encoded}` : `sms:${destination}`;
  } catch {
    return "";
  }
}

export function escapeEmbedHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function pngDataUrlBytes(dataUrl: string): Uint8Array {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("invalid_qr_image");
  const binary = atob(dataUrl.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function TapToTextBlockEditor(): ReactElement {
  const [shortCode, setShortCode] = useState<string>("");
  const [keyword, setKeyword] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [downloadingQr, setDownloadingQr] = useState<boolean>(false);

  const destination = useMemo(
    () => parseSmsDestination(shortCode),
    [shortCode],
  );
  const keywordValid = isSafeLocalCreativeText(keyword, 40, false);
  const labelValid = isSafeLocalCreativeText(label, 120, true);
  const uri = useMemo(
    () =>
      destination && keywordValid && labelValid
        ? buildSmsUri(destination, keyword)
        : "",
    [destination, keyword, keywordValid, labelValid],
  );
  const valid = uri.length > 0;

  useEffect(() => {
    let active = true;
    setQrDataUrl(null);
    setQrError(false);
    if (!valid) return () => undefined;
    void QRCode.toDataURL(uri, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: "M",
    })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrError(true);
      });
    return () => {
      active = false;
    };
  }, [uri, valid]);

  /** HTML snippet ready to paste into a campaign block. */
  const htmlSnippet = useMemo(() => {
    if (!valid || !destination) return "";
    const visibleLabel = label || `Text ${keyword} to ${destination}`;
    return `<a href="${escapeEmbedHtml(uri)}" style="display:inline-block;padding:10px 18px;background:#0e8169;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;font-family:sans-serif;">${escapeEmbedHtml(visibleLabel)}</a>`;
  }, [destination, keyword, label, uri, valid]);

  const copy = async (text: string, what: string): Promise<void> => {
    if (!valid || !text) return;
    const result = await writeClipboardText(text, {
      contentClass: "personal",
      label: what,
    });
    if (result.ok) toast.success(`${what} copied`);
    else toast.error(result.message);
  };

  const downloadQr = async (): Promise<void> => {
    if (downloadingQr || !qrDataUrl) return;
    setDownloadingQr(true);
    try {
      const saved = await saveFile({
        data: pngDataUrlBytes(qrDataUrl),
        suggestedName: "postwave-tap-to-text-qr.png",
        label: "Tap-to-text QR code",
        privacy: "personal",
        mimeType: "image/png",
      });
      if (!saved.ok) throw new Error(saved.message);
      if (saved.status !== "cancelled") toast.success("QR saved");
    } catch {
      toast.error("Couldn't prepare or save the QR image. Try again.");
    } finally {
      setDownloadingQr(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Tap-to-text block</div>
        <div className="card-subtitle muted">
          Generate a local SMS URI and QR creative asset. Opening it may hand
          off to a device SMS composer; the person still reviews and chooses
          whether to send, and device behavior varies.
        </div>
      </div>
      <div className="card-body">
        <div className="notice sms-local-tool-note" role="note">
          Local creative tool only. Generating, copying, or scanning this asset
          does not configure a messaging provider, enroll a person, transmit an
          inbound callback to Moosewave, or record or prove consent.
        </div>
        <div className="sms-tap-to-text-layout">
          <div className="sms-tap-to-text-fields">
            <FormField
              label="Short code or number"
              htmlFor="t2t-short"
              helpTooltip="Enter exactly a 5–6 digit short code or a plus-prefixed E.164 number. Only spaces, parentheses, periods, and hyphens are accepted as display separators."
              error={
                shortCode && !destination
                  ? "Enter an unambiguous 5–6 digit short code or plus-prefixed E.164 number. Letters, controls, bidi marks, and unsigned long numbers are rejected."
                  : undefined
              }
            >
              <input
                id="t2t-short"
                type="tel"
                className="input tabular"
                placeholder="12345"
                value={shortCode}
                onChange={(e) => setShortCode(e.target.value)}
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <FormField
              label="Keyword"
              htmlFor="t2t-keyword"
              helpTooltip="Local pre-populated body only. It does not configure a provider keyword or create consent authority."
              error={
                keyword && !keywordValid
                  ? "Use 1–40 visible Unicode characters without leading/trailing space, controls, bidi marks, or invalid surrogates."
                  : undefined
              }
            >
              <input
                id="t2t-keyword"
                type="text"
                className="input tabular"
                placeholder="JOIN"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <FormField
              label="Button label"
              htmlFor="t2t-label"
              helpTooltip="What the local HTML asset shows. Blank uses the validated canonical destination."
              error={
                label && !labelValid
                  ? "Use at most 120 visible Unicode characters without leading/trailing space, controls, bidi marks, or invalid surrogates."
                  : undefined
              }
            >
              <input
                id="t2t-label"
                type="text"
                className="input"
                placeholder="Text KEYWORD to 12345"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={240}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>

            <FormField label="Generated SMS link" htmlFor="t2t-uri">
              <input
                id="t2t-uri"
                type="text"
                className="input tabular"
                readOnly
                value={uri}
                style={{ fontSize: 12 }}
              />
            </FormField>

            <FormField label="Embed HTML" htmlFor="t2t-html">
              <textarea
                id="t2t-html"
                className="input"
                readOnly
                rows={4}
                value={htmlSnippet}
                style={{
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 11,
                }}
              />
            </FormField>

            <div className="sms-tap-to-text-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copy(uri, "SMS link")}
                disabled={!valid}
              >
                Copy link
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copy(htmlSnippet, "HTML snippet")}
                disabled={!valid}
              >
                Copy HTML
              </button>
              {valid ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void downloadQr()}
                  disabled={downloadingQr || qrDataUrl === null}
                >
                  {downloadingQr
                    ? "Saving…"
                    : qrDataUrl
                      ? "Download QR"
                      : "Preparing QR…"}
                </button>
              ) : null}
            </div>
          </div>

          <div className="sms-tap-to-text-preview">
            <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
              QR preview
            </div>
            {valid && qrError ? (
              <div className="muted sms-tap-to-text-preview-box" role="status">
                Moosewave couldn&apos;t generate this local QR preview. Edit the
                destination or keyword to retry; no provider state changed.
              </div>
            ) : valid && qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="QR code for the generated tap-to-text link"
                width={200}
                height={200}
                // eslint-disable-next-line no-restricted-syntax -- QR quiet zone must stay white for scanner contrast regardless of theme
                style={{ display: "block", background: "#fff", padding: 8 }}
              />
            ) : valid ? (
              <div className="muted sms-tap-to-text-preview-box" role="status">
                Preparing QR preview…
              </div>
            ) : (
              <div className="muted sms-tap-to-text-preview-box">
                Enter a valid destination and keyword to preview a local QR
              </div>
            )}
            <div
              className="tabular muted"
              style={{ fontSize: 11, textAlign: "center", maxWidth: 220 }}
            >
              Local creative preview · no provider or consent effect
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
