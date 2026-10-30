import { type ReactElement, useEffect, useRef, useState } from "react";

import { AuthShell } from "../components/AuthShell";
import type { AuthLinkFlow } from "../lib/auth-link-contract";
import {
  authLinkRecoveryCopy,
  type AuthLinkRecoveryReason,
} from "../lib/auth-link-recovery";
import { AUTH_ASSETS } from "../lib/authAssets";
import { LEGAL_URLS } from "../lib/config";
import { buildDashboardHref, getDashboardUrl } from "../lib/dashboard-url";
import { tauriApi } from "../lib/tauri";

interface Props {
  flow: AuthLinkFlow | null;
  reason: AuthLinkRecoveryReason;
  onRequestNewLink: () => void;
  onUseAnotherMethod: () => void;
  onRetry?: (() => void) | undefined;
}

export function AuthLinkRecovery({
  flow,
  reason,
  onRequestNewLink,
  onUseAnotherMethod,
  onRetry,
}: Props): ReactElement {
  const copy = authLinkRecoveryCopy(reason, flow);
  const alertRef = useRef<HTMLDivElement>(null);
  const [externalError, setExternalError] = useState("");

  useEffect(() => {
    alertRef.current?.focus();
  }, [reason]);

  const openExternal = async (url: string): Promise<void> => {
    setExternalError("");
    try {
      await tauriApi.openUrl(url);
    } catch {
      setExternalError(
        "Moosewave could not open your browser. Check your default-browser settings and try again.",
      );
    }
  };

  const browserPath = flow === "reset" ? "/forgot-password" : "/magic-link";

  return (
    <AuthShell
      tone="blush"
      illustration={AUTH_ASSETS.magicReturn}
      asideEyebrow={copy.eyebrow}
      asideHeadline="Your account is still secure."
      asideSub="Moosewave stopped before consuming a link that could not be verified for this device and request."
      heading={copy.title}
      headingSub={copy.message}
    >
      <div
        ref={alertRef}
        className="auth-state-card"
        role="alert"
        aria-label={`${copy.title}. ${copy.message}`}
        tabIndex={-1}
      >
        <div className="auth-state-icon danger" aria-hidden="true">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 16.5v.5" />
          </svg>
        </div>

        {onRetry ? (
          <button
            type="button"
            className="btn btn-primary auth-submit-v2"
            onClick={onRetry}
          >
            Retry this link
          </button>
        ) : null}
        <button
          type="button"
          className={
            onRetry ? "btn auth-submit-v2" : "btn btn-primary auth-submit-v2"
          }
          onClick={onRequestNewLink}
        >
          {flow === "reset"
            ? "Request a new reset link"
            : "Request a new sign-in link"}
        </button>
        <button
          type="button"
          className="btn auth-submit-v2"
          onClick={onUseAnotherMethod}
        >
          Use another sign-in method
        </button>
        <button
          type="button"
          className="btn auth-submit-v2"
          onClick={() =>
            void openExternal(
              buildDashboardHref(getDashboardUrl(), browserPath),
            )
          }
        >
          Continue in browser
        </button>
        <button
          type="button"
          className="btn auth-submit-v2"
          onClick={() => void openExternal(LEGAL_URLS.support)}
        >
          Contact support
        </button>
        {externalError ? <p role="alert">{externalError}</p> : null}
      </div>
    </AuthShell>
  );
}
