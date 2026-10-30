/**
 * MfaChallenge — 6-digit TOTP code (or 1 recovery code) input. Used in
 * two places:
 *
 *   1. Mid-login: the cookie is set but the tenant requires MFA, so we
 *      gate access until /totp/challenge succeeds.
 *
 *   2. Mid-app: a step-up challenge fired by an action that needs
 *      `mfa_satisfied=true` in the session.
 *
 * The handler short-circuits with `already=true` if the session is
 * already MFA-satisfied; we treat that as a successful satisfy.
 *
 * v2: per-digit OTP pads with auto-advance on type, backspace-erase,
 * arrow-key navigation, and clipboard paste (one paste of a 6-digit
 * code fans out across all 6 cells). Recovery mode falls back to a
 * single mono input.
 */

import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import { apiAuth } from "../lib/api-client";
import { AUTH_ASSETS } from "../lib/authAssets";
import { redact } from "../lib/auth";
import { AuthShell } from "./AuthShell";
import { FieldError, FormField, useFormErrors } from "./FormField";

interface Props {
  onSatisfied: () => void;
  onCancel: () => void;
}

const OTP_LEN = 6;

export function MfaChallenge({
  onSatisfied,
  onCancel,
}: Props): ReactElement {
  const [digits, setDigits] = useState<string[]>(Array(OTP_LEN).fill(""));
  const [recovery, setRecovery] = useState<string>("");
  const [recoveryMode, setRecoveryMode] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const errors = useFormErrors();
  const cellRefs = useRef<Array<HTMLInputElement | null>>([]);

  /* Auto-focus the first cell when the OTP form mounts. */
  useEffect(() => {
    if (!recoveryMode) {
      cellRefs.current[0]?.focus();
    }
  }, [recoveryMode]);

  function setDigit(idx: number, value: string): void {
    /* Accept only the last digit of a typed string (handles repeated
     * presses where the input still echoes the prior digit). */
    const c = value.replace(/\D/g, "").slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[idx] = c;
      return next;
    });
    if (c && idx < OTP_LEN - 1) {
      cellRefs.current[idx + 1]?.focus();
    }
  }

  function onCellKey(idx: number, e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      cellRefs.current[idx - 1]?.focus();
      return;
    }
    if (e.key === "ArrowLeft" && idx > 0) {
      e.preventDefault();
      cellRefs.current[idx - 1]?.focus();
      return;
    }
    if (e.key === "ArrowRight" && idx < OTP_LEN - 1) {
      e.preventDefault();
      cellRefs.current[idx + 1]?.focus();
    }
  }

  function onCellPaste(e: React.ClipboardEvent<HTMLInputElement>): void {
    const pasted = (e.clipboardData.getData("text") || "")
      .replace(/\D/g, "")
      .slice(0, OTP_LEN);
    if (!pasted) return;
    e.preventDefault();
    const next = Array(OTP_LEN).fill("");
    for (let i = 0; i < pasted.length; i++) {
      next[i] = pasted[i];
    }
    setDigits(next);
    /* Focus the next empty cell, or the last one if all are filled. */
    const focusIdx = Math.min(pasted.length, OTP_LEN - 1);
    cellRefs.current[focusIdx]?.focus();
  }

  const otpValue = digits.join("");

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    errors.clear();
    const submitted = recoveryMode ? recovery.trim() : otpValue;
    if (!submitted) {
      errors.set(
        "code",
        recoveryMode ? "Enter a recovery code" : "Enter the 6-digit code",
      );
      return;
    }
    if (!recoveryMode && submitted.length < OTP_LEN) {
      errors.set("code", `Enter all ${OTP_LEN} digits`);
      return;
    }
    setBusy(true);
    const res = await apiAuth.totpChallenge(
      recoveryMode ? { recovery_code: submitted } : { code: submitted },
    );
    setBusy(false);
    if (res.error) {
      errors.set("_form", redact(res.error.message));
      /* Wipe the digits on failure so the user can try a fresh code. */
      if (!recoveryMode) {
        setDigits(Array(OTP_LEN).fill(""));
        cellRefs.current[0]?.focus();
      }
      return;
    }
    onSatisfied();
  };

  return (
    <AuthShell
      tone="blue"
      illustration={AUTH_ASSETS.magicReturn}
      asideEyebrow="Two-factor verification"
      asideHeadline="One more check."
      asideSub={
        recoveryMode
          ? "Enter one of the single-use recovery codes you saved when you set up two-factor. Each one works once."
          : "Open your authenticator app and enter the 6-digit code for Moosewave. The code rotates every 30 seconds."
      }
      heading="Two-factor verification"
      headingSub={
        recoveryMode
          ? "Enter one of your recovery codes."
          : "Enter the 6-digit code from your authenticator app."
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        {recoveryMode ? (
          <FormField
            label="Recovery code"
            htmlFor="mfa-recovery"
            required
            error={errors.get("code")}
          >
            <input
              id="mfa-recovery"
              type="text"
              className="input mono"
              value={recovery}
              onChange={(e) => {
                setRecovery(e.target.value);
                if (errors.get("code")) errors.clear("code");
              }}
              placeholder="xxxxx-xxxxx"
              autoComplete="one-time-code"
              maxLength={32}
            />
          </FormField>
        ) : (
          <div className="field-v2">
            <label className="field-v2-label" htmlFor="mfa-otp-0">
              Authentication code
            </label>
            <div className="auth-otp" role="group" aria-label="6-digit code">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    cellRefs.current[i] = el;
                  }}
                  id={i === 0 ? "mfa-otp-0" : undefined}
                  type="text"
                  inputMode="numeric"
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  className={`auth-otp-cell${d ? " is-filled" : ""}`}
                  value={d}
                  maxLength={1}
                  onChange={(e) => {
                    setDigit(i, e.target.value);
                    if (errors.get("code")) errors.clear("code");
                  }}
                  onKeyDown={(e) => onCellKey(i, e)}
                  onPaste={onCellPaste}
                  aria-label={`Digit ${i + 1}`}
                />
              ))}
            </div>
            {errors.get("code") ? (
              <FieldError>{errors.get("code")}</FieldError>
            ) : null}
          </div>
        )}

        {errors.get("_form") ? <FieldError>{errors.get("_form")}</FieldError> : null}

        <button
          type="submit"
          className="btn btn-primary auth-submit-v2"
          disabled={busy}
          style={{ marginTop: 12 }}
        >
          {busy ? <span className="auth-submit-v2-spinner" aria-hidden="true" /> : null}
          {busy ? "Verifying…" : "Verify"}
        </button>

        <button
          type="button"
          className="btn"
          style={{ width: "100%", marginTop: 8 }}
          onClick={() => {
            setRecoveryMode(!recoveryMode);
            errors.clear();
            setDigits(Array(OTP_LEN).fill(""));
            setRecovery("");
          }}
        >
          {recoveryMode
            ? "Use authenticator code instead"
            : "Use a recovery code instead"}
        </button>

        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "100%", marginTop: 8 }}
          onClick={onCancel}
        >
          Cancel
        </button>
      </form>
    </AuthShell>
  );
}
