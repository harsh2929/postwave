// SPDX-License-Identifier: MIT

/**
 * PostwaveAuditPortal.tsx — drop-in iframe wrapper for the embeddable
 * audit portal (apps/audit-portal/).
 *
 * The component owns:
 *
 *   1. an iframe pointing at `sessionUrl`,
 *   2. a postMessage bridge listening for { type: "postwave:error" |
 *      "postwave:loaded" } messages from the portal SPA so the host
 *      can fire `onError` / `onLoaded` callbacks,
 *   3. resize affordances (height prop + auto-grow via postMessage
 *      height events) so the portal grows with the user's audit log.
 *
 * Usage:
 *
 *   <PostwaveAuditPortal
 *     sessionUrl={portalSession.portal_url}
 *     portalOrigin="https://audit.postwave.example"
 *     parentOrigin="https://app.customer.example"
 *     height={640}
 *     onError={(e) => console.error("portal error", e)}
 *   />
 *
 * Security note: the host page must allow framing of the portal origin via
 * `frame-src`; the portal deployment must list the host in
 * POSTWAVE_PORTAL_FRAME_ANCESTORS. The session URL carries a one-time token
 * only in its fragment, scrubs it before network I/O, then uses a partitioned
 * HttpOnly cookie.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import { portalSessionOrigin, withPortalTheme } from "./session-url.js";

export interface PortalErrorEvent {
  /** Free-form message; reflects an api-level error or a JWT
   *  validation failure surfaced by the SPA. */
  message: string;
  /** HTTP status when the failure originated in a portal API call. */
  status?: number;
}

export interface PostwaveAuditPortalProps {
  /** Full URL from POST /api/v1/audit/portal/sessions.portal_url. */
  sessionUrl: string;
  /** Exact HTTPS origin of the separately hosted audit portal. */
  portalOrigin: string;
  /** Exact HTTPS origin of the embedding application. The portal uses this
   *  only as postMessage targetOrigin and never falls back to a wildcard. */
  parentOrigin: string;
  /** Optional fixed iframe height in px. Defaults to 600 + auto-resize. */
  height?: number;
  /** Optional fixed iframe width. Defaults to 100%. */
  width?: number | string;
  /** Optional iframe title for screen readers. */
  title?: string;
  /** Fires when the portal posts a { type: "postwave:error" } message. */
  onError?: (event: PortalErrorEvent) => void;
  /** Fires when the portal posts { type: "postwave:loaded" }. */
  onLoaded?: () => void;
  /** Optional theme override forwarded to the iframe via querystring;
   *  the SPA reads it from URL on boot. */
  theme?: "light" | "dark";
  /** Override className for the iframe wrapper element. */
  className?: string;
  /** Override inline style for the iframe wrapper element. */
  style?: CSSProperties;
}

interface PortalMessage {
  type: string;
  message?: string;
  status?: number;
  height?: number;
}

function clampFrameHeight(value: number): number {
  return Number.isFinite(value)
    ? Math.min(4_096, Math.max(240, Math.round(value)))
    : 600;
}

export function PostwaveAuditPortal({
  sessionUrl,
  portalOrigin,
  parentOrigin,
  height = 600,
  width = "100%",
  title = "Moosewave audit portal",
  onError,
  onLoaded,
  theme,
  className,
  style,
}: PostwaveAuditPortalProps): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState(() =>
    clampFrameHeight(height),
  );

  const finalUrl = withPortalTheme(
    sessionUrl,
    theme,
    portalOrigin,
    parentOrigin,
  );

  useEffect(() => setMeasuredHeight(clampFrameHeight(height)), [height]);

  useEffect(() => {
    const expectedOrigin = portalSessionOrigin(sessionUrl, portalOrigin);

    function onMessage(ev: MessageEvent): void {
      // Origin pinning — drop messages from any origin that isn't
      // the portal's. Prevents a third-party iframe from spoofing
      // portal events to the host page.
      if (!expectedOrigin || ev.origin !== expectedOrigin) return;
      if (ev.source !== iframeRef.current?.contentWindow) return;
      const data = ev.data as PortalMessage | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string")
        return;
      if (!data.type.startsWith("postwave:")) return;
      switch (data.type) {
        case "postwave:loaded":
          onLoaded?.();
          break;
        case "postwave:error":
          onError?.({
            message:
              typeof data.message === "string" && data.message.length <= 500
                ? data.message
                : "unknown error",
            status:
              typeof data.status === "number" &&
              Number.isInteger(data.status) &&
              data.status >= 100 &&
              data.status <= 599
                ? data.status
                : undefined,
          });
          break;
        case "postwave:resize":
          if (typeof data.height === "number" && Number.isFinite(data.height)) {
            setMeasuredHeight(clampFrameHeight(data.height));
          }
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sessionUrl, portalOrigin, onError, onLoaded]);

  return (
    <iframe
      ref={iframeRef}
      src={finalUrl}
      title={title}
      // sandbox: allow-scripts + allow-same-origin let the portal SPA
      // run (it needs same-origin to call the cookie-authenticated,
      // read-only /api/v1/audit/portal/* routes). We do NOT allow form
      // submission / top navigation
      // / popups so a hijacked SPA can't escape the iframe.
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      loading="lazy"
      className={className}
      style={{
        width,
        height: measuredHeight,
        border: 0,
        background: "white",
        display: "block",
        ...style,
      }}
    />
  );
}
