import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  apiAuth,
  type AuthDeviceGrantDisclosure,
  type AuthMeResponse,
} from "../../lib/api-client";

type CompletedAction = "approved" | "denied";
type DisplayedGrant = Omit<AuthDeviceGrantDisclosure, "consent_token">;

const DEVICE_TYPES = new Set([
  "desktop",
  "mobile",
  "tablet",
  "cli",
  "bot",
  "unknown",
]);
const MAX_DISCLOSURE_CHARS = 160;
const MAX_SCOPES = 64;
const MAX_CONSENT_TOKEN_BYTES = 4_096;

function formatUserCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return normalized.length > 4
    ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
    : normalized;
}

function validDisclosureText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_DISCLOSURE_CHARS &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validOptionalDisclosureText(value: unknown): boolean {
  return value === undefined || validDisclosureText(value);
}

function validConsentToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_CONSENT_TOKEN_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validDisclosure(
  value: unknown,
  requireSessionConsent = false,
  requireApiKeyScopes = true,
): value is AuthDeviceGrantDisclosure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const disclosure = value as Record<string, unknown>;
  const device = disclosure.device;
  const account = disclosure.account;
  if (!device || typeof device !== "object" || Array.isArray(device)) {
    return false;
  }
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    return false;
  }
  const deviceFields = device as Record<string, unknown>;
  const accountFields = account as Record<string, unknown>;
  const scopes = disclosure.scopes;
  return (
    (disclosure.grant_kind === "session" ||
      disclosure.grant_kind === "api_key") &&
    typeof disclosure.expires_in === "number" &&
    Number.isInteger(disclosure.expires_in) &&
    disclosure.expires_in > 0 &&
    disclosure.expires_in <= 60 * 60 &&
    typeof disclosure.remember === "boolean" &&
    validDisclosureText(deviceFields.device_label) &&
    typeof deviceFields.device_type === "string" &&
    DEVICE_TYPES.has(deviceFields.device_type) &&
    validOptionalDisclosureText(deviceFields.device_os) &&
    validOptionalDisclosureText(deviceFields.device_client) &&
    validDisclosureText(accountFields.email) &&
    validOptionalDisclosureText(accountFields.workspace_name) &&
    validOptionalDisclosureText(accountFields.workspace_slug) &&
    (disclosure.requires_mfa === undefined ||
      typeof disclosure.requires_mfa === "boolean") &&
    (!requireSessionConsent ||
      disclosure.grant_kind !== "session" ||
      validConsentToken(disclosure.consent_token)) &&
    (!requireApiKeyScopes ||
      disclosure.grant_kind === "session" ||
      (Array.isArray(scopes) &&
        scopes.length > 0 &&
        scopes.length <= MAX_SCOPES &&
        scopes.every(validDisclosureText)))
  );
}

function approvalFailure(code?: string): string {
  switch (code) {
    case "bad_user_code":
      return "Enter the complete 8-character code shown on the other device.";
    case "invalid_or_expired":
      return "That request is invalid, expired, or was already handled.";
    case "mfa_required":
      return "Complete two-factor verification for this session, then inspect the request again.";
    case "consent_required":
      return "This request or your account session changed. Review the request again before deciding.";
    case "insufficient_role":
      return "Your workspace role cannot authorize this request.";
    default:
      return "Moosewave couldn't verify this device request. Try again.";
  }
}

function expiresCopy(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1
    ? "Expires in 1 minute"
    : `Expires in ${minutes} minutes`;
}

function Disclosure({ grant }: { grant: DisplayedGrant }): ReactElement {
  const sessionGrant = grant.grant_kind === "session";
  return (
    <div className="settings-device-disclosure">
      <div className="settings-device-disclosure-row">
        <span>Reported requesting device</span>
        <strong>{grant.device.device_label}</strong>
        <small>
          {[grant.device.device_client, grant.device.device_os]
            .filter(Boolean)
            .join(" · ") || grant.device.device_type}
        </small>
      </div>
      <div className="settings-device-disclosure-row">
        <span>Account and workspace</span>
        <strong>{grant.account.email}</strong>
        <small>
          {grant.account.workspace_name ||
            grant.account.workspace_slug ||
            "Current workspace"}
        </small>
      </div>
      <div className="settings-device-disclosure-row">
        <span>Access being granted</span>
        <strong>
          {sessionGrant ? "Moosewave sign-in" : "Moosewave API key"}
        </strong>
        <small>
          {sessionGrant
            ? grant.remember
              ? "A remembered session for up to 30 days"
              : "A short desktop/browser session for up to 12 hours"
            : "A durable CLI credential with the permissions below"}
        </small>
      </div>
      {!sessionGrant ? (
        <div className="settings-device-scopes">
          <span>Permissions</span>
          {grant.scopes?.length ? (
            <ul>
              {grant.scopes.map((scope) => (
                <li key={scope}>
                  <code>{scope}</code>
                </li>
              ))}
            </ul>
          ) : (
            <small>No permissions were disclosed. Do not approve.</small>
          )}
          {grant.requires_mfa ? (
            <small>Two-factor verification is required before approval.</small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DeviceApprovalSection({
  me,
}: {
  me: AuthMeResponse | null;
}): ReactElement {
  const [userCode, setUserCode] = useState("");
  const [grant, setGrant] = useState<DisplayedGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState<CompletedAction | null>(null);
  const operationRef = useRef(false);
  const consentTokenRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      operationRef.current = false;
      consentTokenRef.current = null;
    };
  }, []);

  const reset = (): void => {
    if (operationRef.current) return;
    setUserCode("");
    setGrant(null);
    consentTokenRef.current = null;
    setError("");
    setCompleted(null);
  };

  const inspect = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!me || operationRef.current) return;
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) {
      setError(
        "Enter the complete 8-character code shown on the other device.",
      );
      return;
    }
    operationRef.current = true;
    consentTokenRef.current = null;
    const request = ++requestRef.current;
    setBusy(true);
    setError("");
    const response = await apiAuth.inspectDeviceGrant(userCode);
    if (!mountedRef.current || requestRef.current !== request) return;
    operationRef.current = false;
    setBusy(false);
    if (response.error) {
      consentTokenRef.current = null;
      setError(approvalFailure(response.error.code));
      return;
    }
    if (!validDisclosure(response.data, true)) {
      consentTokenRef.current = null;
      setError(
        "Moosewave returned an incomplete device disclosure. Do not approve it.",
      );
      return;
    }
    const { consent_token: consentToken, ...displayedGrant } = response.data;
    consentTokenRef.current =
      response.data.grant_kind === "session" ? (consentToken ?? null) : null;
    setGrant(displayedGrant);
  };

  const decide = async (action: "approve" | "deny"): Promise<void> => {
    if (!grant || operationRef.current) return;
    let consentToken: string | undefined;
    if (grant.grant_kind === "session") {
      const reviewedConsentToken = consentTokenRef.current;
      if (!validConsentToken(reviewedConsentToken)) {
        consentTokenRef.current = null;
        setGrant(null);
        setError("This request must be reviewed again before you can decide.");
        return;
      }
      consentToken = reviewedConsentToken;
    }
    operationRef.current = true;
    const request = ++requestRef.current;
    setBusy(true);
    setError("");
    const response =
      action === "approve"
        ? await apiAuth.approveDeviceGrant(userCode, consentToken)
        : await apiAuth.denyDeviceGrant(userCode, consentToken);
    consentTokenRef.current = null;
    if (!mountedRef.current || requestRef.current !== request) return;
    operationRef.current = false;
    setBusy(false);
    if (response.error) {
      setError(approvalFailure(response.error.code));
      setGrant(null);
      return;
    }
    if (
      response.data.ok !== true ||
      !validDisclosure(response.data, false, action === "approve")
    ) {
      setError(
        "Moosewave returned an incomplete approval result. Check the other device before trying again.",
      );
      setGrant(null);
      return;
    }
    setGrant(null);
    setCompleted(action === "approve" ? "approved" : "denied");
  };

  return (
    <div
      className="settings-section settings-device-approval"
      data-settings-anchor="approve-another-device"
    >
      <div className="settings-section-head">
        <h2 className="settings-section-title">Approve another device</h2>
        <div className="settings-section-sub">
          Enter the matching code from a browser, desktop app, or CLI that is
          waiting to sign in.
        </div>
      </div>
      <div className="settings-section-body" aria-live="polite">
        {!me ? (
          <p className="muted settings-device-message">
            Sign in with an account session to approve another device.
          </p>
        ) : completed ? (
          <div className="settings-device-complete" role="status">
            <strong>
              {completed === "approved" ? "Device approved" : "Request denied"}
            </strong>
            <span>
              {completed === "approved"
                ? "The other device can now finish its request."
                : "The other device has been told that this request was denied."}
            </span>
            <button type="button" className="btn" onClick={reset}>
              Enter another code
            </button>
          </div>
        ) : grant ? (
          <div className="settings-device-review">
            <div className="settings-device-review-head">
              <div>
                <strong>Review before approving</strong>
                <span className="muted mono">{userCode}</span>
              </div>
              <span className="badge warning">
                {expiresCopy(grant.expires_in)}
              </span>
            </div>
            <Disclosure grant={grant} />
            {error ? (
              <div className="auth-error" role="alert">
                {error}
              </div>
            ) : null}
            <p className="muted settings-device-warning">
              Trust the matching code, not the reported device label. Approve
              only if you started this request and the code matches exactly.
            </p>
            <div className="settings-device-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void decide("approve")}
                disabled={
                  busy ||
                  (grant.grant_kind === "api_key" && !grant.scopes?.length)
                }
              >
                {busy
                  ? "Submitting…"
                  : grant.grant_kind === "session"
                    ? "Approve sign-in"
                    : "Authorize API key"}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void decide("deny")}
                disabled={busy}
              >
                Deny request
              </button>
              <button
                type="button"
                className="btn"
                onClick={reset}
                disabled={busy}
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          <form
            className="settings-device-code-form"
            onSubmit={(event) => void inspect(event)}
            noValidate
          >
            <label className="label" htmlFor="settings-device-code">
              Matching code
            </label>
            <div className="settings-device-code-controls">
              <input
                id="settings-device-code"
                className="input mono"
                value={userCode}
                onChange={(event) => {
                  consentTokenRef.current = null;
                  setUserCode(formatUserCode(event.target.value));
                  if (error) setError("");
                }}
                placeholder="ABCD-EFGH"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                maxLength={9}
                aria-invalid={Boolean(error)}
                aria-describedby={
                  error ? "settings-device-code-error" : undefined
                }
                disabled={busy}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || userCode.length !== 9}
              >
                {busy ? "Checking…" : "Review request"}
              </button>
            </div>
            {error ? (
              <div
                id="settings-device-code-error"
                className="auth-error"
                role="alert"
              >
                {error}
              </div>
            ) : null}
            <p className="muted settings-device-message">
              Moosewave will show the requesting device and exact access before
              anything is approved.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
