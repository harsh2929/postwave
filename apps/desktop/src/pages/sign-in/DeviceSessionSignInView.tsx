import { type ReactElement, useEffect, useState } from "react";
import QRCode from "qrcode";

import { AuthShell } from "../../components/AuthShell";
import { Icon } from "../../components/Icon";
import { LegalLinks } from "../../components/LegalLinks";
import { AUTH_ASSETS } from "../../lib/authAssets";
import type { DeviceSessionSignInState } from "./useDeviceSessionSignIn";

interface Props {
  state: Exclude<DeviceSessionSignInState, { phase: "idle" }>;
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
}

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function LoadingView({ phase }: { phase: "starting" | "cancelling" }) {
  const cancelling = phase === "cancelling";
  return (
    <div className="auth-device-loading" role="status" aria-busy="true">
      <span className="auth-submit-v2-spinner" aria-hidden="true" />
      <strong>
        {cancelling ? "Ending sign-in…" : "Creating a secure code…"}
      </strong>
      <span>
        {cancelling
          ? "Moosewave is clearing the partial session before returning."
          : "This code will be valid for only a few minutes."}
      </span>
    </div>
  );
}

function ErrorView({
  state,
  onCancel,
  onRetry,
}: {
  state: Extract<DeviceSessionSignInState, { phase: "error" }>;
  onCancel: () => Promise<void>;
  onRetry: () => Promise<void>;
}): ReactElement {
  return (
    <div className="auth-device-error" role="alert">
      <span className="auth-state-icon danger" aria-hidden="true">
        <Icon name="alert-triangle" size={28} />
      </span>
      <strong>
        {state.reason === "denied"
          ? "Sign-in denied"
          : state.reason === "expired"
            ? "Code expired"
            : "Device sign-in unavailable"}
      </strong>
      <p>{state.message}</p>
      <div className="auth-device-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void onRetry()}
        >
          Get a new code
        </button>
        <button type="button" className="btn" onClick={() => void onCancel()}>
          Use another sign-in method
        </button>
      </div>
    </div>
  );
}

function QrCode({ value }: { value: string }): ReactElement {
  const [dataUrl, setDataUrl] = useState("");
  useEffect(() => {
    let active = true;
    setDataUrl("");
    void QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 224,
    })
      .then((next) => {
        if (active) setDataUrl(next);
      })
      .catch(() => {
        if (active) setDataUrl("");
      });
    return () => {
      active = false;
    };
  }, [value]);

  if (!dataUrl) {
    return (
      <div className="auth-device-qr-fallback">
        QR unavailable
        <span>Use the address and code shown here.</span>
      </div>
    );
  }
  return (
    <img
      className="auth-device-qr"
      src={dataUrl}
      alt="QR code to approve this desktop sign-in"
      width={224}
      height={224}
    />
  );
}

function WaitingView({
  state,
  onCancel,
}: {
  state: Extract<DeviceSessionSignInState, { phase: "waiting" | "network" }>;
  onCancel: () => Promise<void>;
}): ReactElement {
  const reconnecting = state.phase === "network";
  return (
    <div className="auth-device-pairing">
      <div className="auth-device-qr-frame">
        <QrCode value={state.verificationUriComplete} />
      </div>
      <div className="auth-device-instructions">
        <ol>
          <li>
            On a device where you are already signed in, scan the QR code.
          </li>
          <li>Check that this code matches, then approve the sign-in.</li>
        </ol>
        <div className="auth-device-code-block">
          <span>Matching code</span>
          <code aria-label="Approval code">{state.userCode}</code>
        </div>
        <p className="auth-device-manual">
          No camera? Open <strong>{state.verificationUri}</strong> on a
          signed-in device and enter the code.
        </p>
        <div
          className={`auth-device-status${reconnecting ? " is-offline" : ""}`}
          role="status"
          aria-live="polite"
        >
          <Icon
            name={reconnecting ? "alert-triangle" : "shield-check"}
            size={18}
          />
          <span>
            <strong>
              {reconnecting ? "Connection interrupted" : "Waiting for approval"}
            </strong>
            <span>
              {reconnecting
                ? "We'll keep trying while this code is valid."
                : "You can safely leave this window open."}
            </span>
          </span>
          <time aria-label={`${state.remainingSeconds} seconds remaining`}>
            {formatRemaining(state.remainingSeconds)}
          </time>
        </div>
      </div>
      <p className="auth-device-security-note">
        This creates a 12-hour session on this desktop. Your workspace may still
        require two-factor verification.
      </p>
      <button
        type="button"
        className="btn auth-device-cancel"
        onClick={() => void onCancel()}
      >
        Use another sign-in method
      </button>
    </div>
  );
}

export function DeviceSessionSignInView({
  state,
  onCancel,
  onRetry,
}: Props): ReactElement {
  return (
    <AuthShell
      tone="blue"
      illustration={AUTH_ASSETS.signin}
      asideEyebrow="Secure device approval"
      asideHeadline="Already signed in elsewhere?"
      asideSub="Approve this desktop without moving a password or session secret between devices."
      heading="Sign in with another device"
      headingSub="Use your signed-in phone, tablet, or browser to approve this desktop."
      footer={<LegalLinks />}
    >
      {state.phase === "starting" || state.phase === "cancelling" ? (
        <LoadingView phase={state.phase} />
      ) : state.phase === "error" ? (
        <ErrorView state={state} onCancel={onCancel} onRetry={onRetry} />
      ) : state.phase === "verifying" ? (
        <div className="auth-device-loading" role="status" aria-busy="true">
          <span className="auth-submit-v2-spinner" aria-hidden="true" />
          <strong>Approval received</strong>
          <span>
            {state.connectionIssue
              ? "Connection interrupted. Moosewave is retrying session verification."
              : "Securing your desktop session…"}
          </span>
          <button type="button" className="btn" onClick={() => void onCancel()}>
            Cancel and sign out
          </button>
        </div>
      ) : (
        <WaitingView state={state} onCancel={onCancel} />
      )}
    </AuthShell>
  );
}
