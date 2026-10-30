// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Self-contained QR renderer used by TOTP enrollment (SETC-034). Uses the
// already-bundled `qrcode` dependency to render an SVG string (no network, no
// external image) so authenticator apps can scan the otpauth:// URI directly,
// with paste-to-add still available as a fallback.
//
// `qrcode` is loaded on demand, NOT statically. It carries Galois-field and
// Reed-Solomon tables plus an SJIS map (24.5 KiB raw / 9.4 KiB gz in the
// emitted chunk), and a static import put all of it in the INITIAL JS of
// /login, /totp-challenge, settings/security and the form embed page. /login
// is one of the Lighthouse-certified public routes with a total-blocking-time
// budget, and every visitor there paid the parse for a QR code most of them
// never see. This component already renders asynchronously into state, so
// moving the import inside the effect costs no layout and no extra render.

import { useEffect, useState } from "react";

/**
 * The one function this component needs, from whichever shape the bundler's
 * CommonJS interop produced.
 *
 * Reaching for `default` FIRST is load-bearing: `qrcode` is CommonJS, bundlers
 * put the module object on the interop `default`, and `toString` is the single
 * name that a namespace object inherits from Object.prototype anyway — so a
 * namespace-first lookup cannot tell "the named export" from "the wrong
 * function that returns [object Module]".
 */
type QrcodeModule = Pick<typeof import("qrcode"), "toString">;

async function loadQrcode(): Promise<QrcodeModule> {
  const mod = await import("qrcode");
  const interop = (mod as unknown as { default?: QrcodeModule }).default;
  return interop ?? mod;
}

export function QrCode({
  value,
  size = 176,
  className,
  ariaLabel = "QR code for two-factor authentication setup",
  fallbackMessage = "Couldn't render a QR code — use the setup URI below instead.",
}: {
  value: string;
  size?: number;
  className?: string;
  ariaLabel?: string;
  fallbackMessage?: string;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setSvg(null);
    void (async () => {
      try {
        // A failed chunk fetch lands in the same catch as a failed encode, and
        // reaches the same fallback: the setup URI stays copy-pasteable.
        const qrcode = await loadQrcode();
        const out = await qrcode.toString(value, {
          type: "svg",
          margin: 1,
          errorCorrectionLevel: "M",
          width: size,
        });
        if (active) setSvg(out);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [value, size]);

  if (failed) {
    return (
      <p className="text-xs text-muted-foreground">{fallbackMessage}</p>
    );
  }

  return (
    <div
      className={className}
      style={{ width: size, height: size }}
      // qrcode emits a trusted, self-generated inline SVG (no user HTML).
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      role="img"
      aria-label={ariaLabel}
    />
  );
}
