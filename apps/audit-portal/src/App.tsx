/**
 * App.tsx — root of the audit-portal SPA.
 *
 * Boot sequence:
 *   1. Capture a one-time bootstrap JWT from the URL fragment and scrub the
 *      browser URL synchronously, before making any request.
 *   2. Exchange it for a distinct HttpOnly portal cookie.
 *   3. Fetch /api/v1/audit/portal/branding AND page one of the audit events
 *      together — both depend only on the cookie the exchange minted, not on
 *      each other, so serializing them would spend a whole round trip of
 *      blank screen for nothing. Branding gives us tenant brand name / logo /
 *      primary colour so the portal themes itself per tenant without bundling
 *      the values.
 *   4. Render <AuditPortal /> read-only audit explorer with that first page.
 */
import { type JSX, useEffect, useMemo, useState } from "react";

import type { ApiResult, Branding, ListAuditResponse } from "./lib/portal-api-client";
import { portalParentOrigin } from "./lib/bootstrap";
import { createPortalApiClient } from "./lib/portal-api-client";
import { AuditPortal, PORTAL_PAGE_SIZE } from "./pages/AuditPortal";

type PortalError = { message: string; status?: number };

function notifyParent(message: Record<string, unknown>): void {
  const targetOrigin = portalParentOrigin();
  if (targetOrigin && window.parent !== window) {
    window.parent.postMessage(message, targetOrigin);
  }
}

interface AppProps {
  /** Captured and scrubbed synchronously by main.tsx before React starts. */
  bootstrap?: string;
}

export function App({ bootstrap = "" }: AppProps): JSX.Element {
  const api = useMemo(() => createPortalApiClient(), []);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [initialPage, setInitialPage] =
    useState<ApiResult<ListAuditResponse> | null>(null);
  const [error, setError] = useState<PortalError | null>(null);

  useEffect(() => {
    let cancelled = false;
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }

    void (async () => {
      if (bootstrap) {
        const exchanged = await api.exchangeBootstrap(bootstrap);
        if (!exchanged.ok) {
          if (!cancelled) setError({ message: exchanged.error, status: exchanged.status });
          return;
        }
      }

      const [res, firstPage] = await Promise.all([
        api.getBranding(),
        api.listAudit({ limit: PORTAL_PAGE_SIZE }),
      ]);
      if (cancelled) return;
      setInitialPage(firstPage);
      if (res.ok) setBranding(res.data);
      else {
        setError({
          message: bootstrap
            ? res.error
            : "This portal session is missing or expired. Please request a new link.",
          status: res.status,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, bootstrap]);

  useEffect(() => {
    if (error) {
      notifyParent({ type: "postwave:error", message: error.message, status: error.status });
    } else if (branding) {
      notifyParent({ type: "postwave:loaded" });
    }
  }, [branding, error]);

  useEffect(() => {
    const sendHeight = () => {
      notifyParent({
        type: "postwave:resize",
        height: Math.ceil(document.documentElement.getBoundingClientRect().height),
      });
    };
    sendHeight();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", sendHeight);
      return () => window.removeEventListener("resize", sendHeight);
    }
    const observer = new ResizeObserver(sendHeight);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, []);

  if (error) {
    return (
      <div
        style={{
          padding: 48,
          maxWidth: 520,
          margin: "0 auto",
        }}
      >
        <h1 style={{ fontSize: 20, color: "var(--portal-danger)" }}>
          Audit portal unavailable
        </h1>
        <p style={{ color: "var(--portal-muted)" }}>{error.message}</p>
      </div>
    );
  }

  if (!branding) {
    return (
      <div
        style={{
          padding: 48,
          maxWidth: 520,
          margin: "0 auto",
          color: "var(--portal-muted)",
        }}
      >
        Loading audit portal…
      </div>
    );
  }

  // Override portal CSS variables once branding is resolved.
  const style = {
    "--portal-primary": branding.primary_color,
  } as React.CSSProperties;

  return (
    <div style={style}>
      <header
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--portal-border)",
          background: "var(--portal-surface)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        {branding.logo_url ? (
          <img
            src={branding.logo_url}
            alt={branding.brand_name}
            style={{ height: 24, maxWidth: 120 }}
          />
        ) : (
          <span
            style={{
              fontWeight: 600,
              color: "var(--portal-primary)",
            }}
          >
            {branding.brand_name}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 12,
            color: "var(--portal-muted)",
          }}
        >
          Audit portal · read-only
        </span>
      </header>
      <main style={{ padding: 24 }}>
        <AuditPortal
          api={api}
          branding={branding}
          notifyParent={notifyParent}
          initialPage={initialPage ?? undefined}
        />
      </main>
    </div>
  );
}
