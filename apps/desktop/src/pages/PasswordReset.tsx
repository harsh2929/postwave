/**
 * PasswordReset — request screen. Takes an email, fires
 * /api/v1/auth/password-reset/start, and ALWAYS reports the same
 * "if an account exists, we sent a reset link" copy. Don't disclose
 * registration status; the backend already returns 202 in both cases
 * but we mirror that on the client.
 *
 * v2: uses the shared AuthShell + FormField primitives so the surface
 * matches SignIn / SignUp visually.
 */

import { type FormEvent, type ReactElement, useState } from "react";

import { AuthShell } from "../components/AuthShell";
import { FieldError, FormField, useFormErrors } from "../components/FormField";
import { apiAuth } from "../lib/api-client";
import { beginPasswordResetReturnFlow } from "../lib/auth-flow-state";
import { AUTH_ASSETS } from "../lib/authAssets";
import { redact } from "../lib/auth";

interface Props {
  onBack: () => void;
  initialEmail?: string;
}

export function PasswordReset({
  onBack,
  initialEmail = "",
}: Props): ReactElement {
  const [email, setEmail] = useState<string>(initialEmail);
  const [busy, setBusy] = useState<boolean>(false);
  const [sent, setSent] = useState<boolean>(false);
  const errors = useFormErrors();

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    errors.clear();
    if (!email.trim()) {
      errors.set("email", "Enter your email");
      return;
    }
    setBusy(true);
    let state: string;
    try {
      state = beginPasswordResetReturnFlow();
    } catch {
      setBusy(false);
      errors.set("_form", "Unable to start a secure reset flow. Try again.");
      return;
    }
    const res = await apiAuth.passwordResetStart(email.trim(), state);
    setBusy(false);
    if (res.error) {
      errors.set("_form", redact(res.error.message));
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <AuthShell
        tone="blush"
        illustration={AUTH_ASSETS.magicSent}
        asideEyebrow="Check your inbox"
        asideHeadline="A reset link is on the way."
        asideSub="The link expires in one hour. If you don't see it, check your spam folder — it comes from Moosewave."
        heading="Reset link sent"
        headingSub={`If an account exists for ${email}, we sent a link to choose a new password.`}
      >
        <div className="auth-state-card">
          <div className="auth-state-icon" aria-hidden="true">
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
              <path d="M3 7l9 6 9-6" />
              <rect x="3" y="5" width="18" height="14" rx="2" />
            </svg>
          </div>
          <button
            type="button"
            className="btn btn-primary auth-submit-v2"
            onClick={onBack}
          >
            Back to sign in
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      tone="blush"
      illustration={AUTH_ASSETS.magicSent}
      asideEyebrow="Account recovery"
      asideHeadline="Forgot your password?"
      asideSub="No problem. Enter the email you signed up with and we'll send a link to choose a new password. The link expires in one hour."
      heading="Reset your password"
      headingSub="Enter your account email and we'll send a link to choose a new password."
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <FormField
          label="Email"
          htmlFor="pr-email"
          required
          error={errors.get("email")}
        >
          <input
            id="pr-email"
            name="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (errors.get("email")) errors.clear("email");
              if (errors.get("_form")) errors.clear("_form");
            }}
            placeholder="you@company.com"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </FormField>

        {errors.get("_form") ? (
          <FieldError>{errors.get("_form")}</FieldError>
        ) : null}

        <button
          type="submit"
          className="btn btn-primary auth-submit-v2"
          disabled={busy}
          style={{ marginTop: 12 }}
        >
          {busy ? (
            <span className="auth-submit-v2-spinner" aria-hidden="true" />
          ) : null}
          {busy ? "Sending…" : "Send reset link"}
        </button>
        <button
          type="button"
          className="btn"
          style={{ width: "100%", marginTop: 8 }}
          onClick={onBack}
        >
          Back to sign in
        </button>
      </form>
    </AuthShell>
  );
}
