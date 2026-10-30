// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Tap-to-text block (desktop components/sms/TapToTextBlockEditor.tsx,
// GAP-LS-148). Generates an `sms:` intent link with a reviewed short code or
// E.164 destination and a pre-populated keyword, plus an embeddable HTML
// button and a QR code for print/email/web creative.
//
// Everything stays in the browser: the link, the HTML and the QR are derived
// locally, and nothing is sent to Moosewave or a provider. Generating, copying
// or scanning the asset does not configure a provider keyword, enroll anyone,
// or record consent — the person still reviews and sends the text themselves.

import { useEffect, useId, useMemo, useState } from "react";
import { Copy, Download, QrCode } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { copyToClipboard } from "@/lib/clipboard";
import { downloadTextFile } from "@/lib/download";

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/**
 * Canonicalize only explicitly reviewed ASCII display separators. Unknown
 * characters are rejected instead of silently changing recipient identity.
 */
export function parseSmsDestination(value: string): string | null {
  if (value.length === 0 || value.length > 32) return null;
  const trimmed = value.replace(/^ +| +$/gu, "");
  if (trimmed.length === 0 || UNSAFE_TEXT.test(trimmed)) return null;
  if (/^[0-9]{5,6}$/u.test(trimmed)) return trimmed;
  if (!/^\+[0-9 ().-]+[0-9]$/u.test(trimmed)) return null;
  const digits = trimmed.slice(1).replace(/[ ().-]/gu, "");
  return /^[1-9][0-9]{6,14}$/u.test(digits) ? `+${digits}` : null;
}

function isSafeCreativeText(
  value: string,
  maxScalars: number,
  allowEmpty: boolean,
): boolean {
  if (
    value.trim() !== value ||
    (!allowEmpty && value === "") ||
    UNSAFE_TEXT.test(value)
  ) {
    return false;
  }
  return Array.from(value).length <= maxScalars;
}

/** RFC 5724 `sms:<number>?body=<text>`; spaces stay %20, never '+'. */
export function buildSmsUri(destinationInput: string, body: string): string {
  const destination = parseSmsDestination(destinationInput);
  if (!destination || !isSafeCreativeText(body, 40, true)) return "";
  try {
    return body
      ? `sms:${destination}?body=${encodeURIComponent(body)}`
      : `sms:${destination}`;
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
      })[character] ?? character,
  );
}

export function tapToTextHtml(
  uri: string,
  destination: string,
  keyword: string,
  label: string,
): string {
  const visible = label || `Text ${keyword} to ${destination}`;
  return `<a href="${escapeEmbedHtml(uri)}" style="display:inline-block;padding:10px 18px;background:#0e8169;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;font-family:sans-serif;">${escapeEmbedHtml(visible)}</a>`;
}

interface QrState {
  uri: string;
  dim: number;
  path: string;
  svg: string;
}

export function TapToTextBlockEditor() {
  const [shortCode, setShortCode] = useState("");
  const [keyword, setKeyword] = useState("");
  const [label, setLabel] = useState("");
  const [qr, setQr] = useState<QrState | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const ids = {
    short: useId(),
    keyword: useId(),
    label: useId(),
    uri: useId(),
    html: useId(),
    shortError: useId(),
    keywordError: useId(),
    labelError: useId(),
  };

  const destination = useMemo(() => parseSmsDestination(shortCode), [shortCode]);
  const keywordValid = isSafeCreativeText(keyword, 40, false);
  const labelValid = isSafeCreativeText(label, 120, true);
  const uri =
    destination && keywordValid && labelValid
      ? buildSmsUri(destination, keyword)
      : "";
  const valid = uri.length > 0;
  const html =
    valid && destination ? tapToTextHtml(uri, destination, keyword, label) : "";
  const readyQr = qr && qr.uri === uri ? qr : null;

  useEffect(() => {
    let active = true;
    setQrFailed(false);
    if (!uri) return () => undefined;
    // The encoder is loaded on demand so `qrcode` never joins the SMS
    // workspace's initial chunk (see qr-code-lazy.test.tsx).
    void import("@/lib/qr-code")
      .then(({ qrPath, qrSvg }) => {
        const matrix = qrPath(uri, { margin: 2 });
        const svg = qrSvg(uri, { margin: 2 });
        if (active) setQr({ uri, dim: matrix.dim, path: matrix.path, svg });
      })
      .catch(() => {
        if (active) setQrFailed(true);
      });
    return () => {
      active = false;
    };
  }, [uri]);

  const copy = async (text: string, what: string): Promise<void> => {
    if (!valid || !text) return;
    const result = await copyToClipboard(text);
    setStatus(
      result === "copied"
        ? `${what} copied.`
        : result === "unavailable"
          ? `Clipboard is unavailable in this browser — select the ${what.toLowerCase()} field and copy it manually.`
          : `The browser refused the clipboard write. Select the ${what.toLowerCase()} field and copy it manually.`,
    );
  };

  const downloadQr = (): void => {
    if (!readyQr) return;
    downloadTextFile(
      "postwave-tap-to-text-qr.svg",
      readyQr.svg,
      "image/svg+xml;charset=utf-8",
    );
    setStatus("QR code downloaded as SVG.");
  };

  return (
    <Card data-testid="tap-to-text-block">
      <CardHeader>
        <CardTitle className="text-base">Tap-to-text block</CardTitle>
        <CardDescription>
          Generate an SMS link, HTML button, and QR code for email, web, or
          print creative. Opening it may hand off to the device&apos;s SMS
          composer; the person still reviews and chooses whether to send.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p role="note" className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          Local creative tool only. Generating, copying, or scanning this asset
          does not configure a messaging provider, enroll a person, send
          anything to Moosewave, or record or prove consent.
        </p>
        <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className="min-w-0 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={ids.short}>Short code or number</Label>
              <Input
                id={ids.short}
                type="tel"
                className="tabular-nums"
                placeholder="12345"
                value={shortCode}
                maxLength={32}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={shortCode !== "" && !destination}
                aria-describedby={
                  shortCode && !destination ? ids.shortError : undefined
                }
                onChange={(event) => setShortCode(event.target.value)}
              />
              {shortCode && !destination ? (
                <p id={ids.shortError} className="text-xs text-destructive-emphasis">
                  Enter a 5–6 digit short code or a plus-prefixed E.164
                  number. Letters, hidden characters, and unsigned long
                  numbers are rejected.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.keyword}>Keyword</Label>
              <Input
                id={ids.keyword}
                placeholder="JOIN"
                value={keyword}
                maxLength={80}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={keyword !== "" && !keywordValid}
                aria-describedby={
                  keyword && !keywordValid ? ids.keywordError : undefined
                }
                onChange={(event) => setKeyword(event.target.value)}
              />
              {keyword && !keywordValid ? (
                <p id={ids.keywordError} className="text-xs text-destructive-emphasis">
                  Use 1–40 visible characters without leading or trailing
                  spaces or hidden characters.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.label}>Button label (optional)</Label>
              <Input
                id={ids.label}
                placeholder="Text JOIN to 12345"
                value={label}
                maxLength={240}
                autoComplete="off"
                aria-invalid={label !== "" && !labelValid}
                aria-describedby={
                  label && !labelValid ? ids.labelError : undefined
                }
                onChange={(event) => setLabel(event.target.value)}
              />
              {label && !labelValid ? (
                <p id={ids.labelError} className="text-xs text-destructive-emphasis">
                  Use at most 120 visible characters without leading or
                  trailing spaces or hidden characters.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.uri}>Generated SMS link</Label>
              <Input
                id={ids.uri}
                readOnly
                value={uri}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.html}>Embed HTML</Label>
              <Textarea
                id={ids.html}
                readOnly
                rows={4}
                value={html}
                className="font-mono text-xs"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!valid}
                onClick={() => void copy(uri, "SMS link")}
              >
                <Copy aria-hidden />
                Copy link
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!valid}
                onClick={() => void copy(html, "HTML snippet")}
              >
                <Copy aria-hidden />
                Copy HTML
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!readyQr}
                onClick={downloadQr}
              >
                <Download aria-hidden />
                {valid && !readyQr && !qrFailed ? "Preparing QR…" : "Download QR"}
              </Button>
            </div>
            {status ? (
              <p role="status" className="text-xs text-muted-foreground">
                {status}
              </p>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">
              QR preview
            </span>
            {valid && qrFailed ? (
              <p role="status" className="text-center text-xs text-muted-foreground">
                The QR preview could not be generated. Edit the destination or
                keyword to retry; nothing was sent anywhere.
              </p>
            ) : readyQr ? (
              <svg
                viewBox={`0 0 ${readyQr.dim} ${readyQr.dim}`}
                className="h-44 w-44 rounded-md border bg-white p-2"
                shapeRendering="crispEdges"
                role="img"
                aria-label="QR code for the generated tap-to-text link"
                data-testid="tap-to-text-qr"
              >
                <rect width={readyQr.dim} height={readyQr.dim} fill="#ffffff" />
                <path d={readyQr.path} fill="#0f172a" />
              </svg>
            ) : (
              <div className="flex h-44 w-44 items-center justify-center rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                <QrCode className="mr-1 h-4 w-4" aria-hidden />
                {valid
                  ? "Preparing QR preview…"
                  : "Enter a valid destination and keyword"}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
