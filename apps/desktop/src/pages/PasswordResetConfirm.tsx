/**
 * PasswordResetConfirm — opened via the deep-link
 * `moosewave://auth/reset?<signed-v1-envelope>`. Takes new + confirm passwords,
 * calls /api/v1/auth/password-reset/confirm, then routes back to sign
 * in (the backend revokes any prior sessions, so the user re-logs in
 * with the new password).
 *
 * v2: shared AuthShell + FormField + live PasswordRequirements
 * checklist + better success state.
 */

import { type FormEvent, type ReactElement, useState } from "react";

import { AuthShell } from "../components/AuthShell";
import { FieldError, FormField, useFormErrors } from "../components/FormField";
import {
  PasswordRequirements,
  allPasswordRulesPass,
} from "../components/PasswordRequirements";
import { apiAuth } from "../lib/api-client";
import type { DesktopAuthLinkProof } from "../lib/auth-link-contract";
import {
  classifyAuthLinkApiError,
  type AuthLinkRecoveryReason,
} from "../lib/auth-link-recovery";
import { AUTH_ASSETS } from "../lib/authAssets";
import { AuthLinkRecovery } from "./AuthLinkRecovery";

interface Props {
  proof: DesktopAuthLinkProof;
  onDone: () => void;
  onRequestNewLink: () => void;
}

export function PasswordResetConfirm({
  proof,
  onDone,
  onRequestNewLink,
}: Props): ReactElement {
  const [password, setPassword] = useState<string>("");
  const [confirm, setConfirm] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [done, setDone] = useState<boolean>(false);
  const [linkFailure, setLinkFailure] = useState<AuthLinkRecoveryReason | null>(
    null,
  );
  const errors = useFormErrors();

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    errors.clear();
    if (!allPasswordRulesPass(password)) {
      errors.set("password", "Password doesn't meet all requirements yet");
      return;
    }
    if (password !== confirm) {
      errors.set("confirm", "Passwords don't match");
      return;
    }
    setBusy(true);
    const res = await apiAuth.passwordResetConfirm(proof, password);
    setBusy(false);
    if (res.error) {
      setLinkFailure(classifyAuthLinkApiError(res.error));
      return;
    }
    setDone(true);
  };

  if (linkFailure) {
    return (
      <AuthLinkRecovery
        flow="reset"
        reason={linkFailure}
        onRequestNewLink={onRequestNewLink}
        onUseAnotherMethod={onDone}
        onRetry={
          linkFailure === "temporary_failure"
            ? () => setLinkFailure(null)
            : undefined
        }
      />
    );
  }

  if (done) {
    return (
      <AuthShell
        tone="mint"
        illustration={AUTH_ASSETS.magicReturn}
        asideEyebrow="All set"
        asideHeadline="Password reset."
        asideSub="Your password has been updated and any prior sessions have been signed out. You're set to sign in with the new password."
        heading="Password updated"
        headingSub="All prior sessions have been signed out. Sign back in with your new password."
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
              <path d="M5 12l4 4 10-10" />
            </svg>
          </div>
          <button
            type="button"
            className="btn btn-primary auth-submit-v2"
            onClick={onDone}
          >
            Continue to sign in
          </button>
        </div>
      </AuthShell>
    );
  }

  const allRulesOk = allPasswordRulesPass(password);

  return (
    <AuthShell
      tone="blush"
      illustration={AUTH_ASSETS.magicReturn}
      asideEyebrow="Choose a new password"
      asideHeadline="One step from getting back in."
      asideSub="Your new password needs to be at least 12 characters and include an uppercase letter, a number, and a symbol. After you reset, all other sessions sign out."
      heading="Choose a new password"
      headingSub="Pick a strong password — 12 characters with at least one uppercase, number, and symbol."
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <FormField
          label="New password"
          htmlFor="prc-pw"
          required
          error={errors.get("password")}
        >
          <input
            id="prc-pw"
            type="password"
            className="input"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (errors.get("password")) errors.clear("password");
            }}
            placeholder="Choose a strong password"
            autoComplete="new-password"
            required
          />
          <PasswordRequirements value={password} />
        </FormField>

        <FormField
          label="Confirm password"
          htmlFor="prc-confirm"
          required
          error={errors.get("confirm")}
        >
          <input
            id="prc-confirm"
            type="password"
            className="input"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              if (errors.get("confirm")) errors.clear("confirm");
            }}
            placeholder="Re-enter the new password"
            autoComplete="new-password"
            required
          />
        </FormField>

        {errors.get("_form") ? (
          <FieldError>{errors.get("_form")}</FieldError>
        ) : null}

        <button
          type="submit"
          className="btn btn-primary auth-submit-v2"
          disabled={busy || !allRulesOk || password !== confirm}
          style={{ marginTop: 12 }}
        >
          {busy ? (
            <span className="auth-submit-v2-spinner" aria-hidden="true" />
          ) : null}
          {busy ? "Resetting…" : "Reset password"}
        </button>
      </form>
    </AuthShell>
  );
}
