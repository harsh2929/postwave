/**
 * TotpSetupModal — three-step flow:
 *
 *   1. /enroll → server returns otpauth_uri + recovery_codes. Render the
 *      otpauth URI as a QR for the user's authenticator app to scan.
 *
 *   2. /verify with the code shown by the authenticator. On success the
 *      enrollment is durable and the current session is marked
 *      mfa_satisfied.
 *
 *   3. Show the recovery codes ONCE with an "I've saved these" button.
 *      The server only stores hashes; this is the only chance to copy
 *      them.
 *
 * QR rendering uses the `qrcode` npm package (CJS in node_modules).
 * We render to a data URL and stick it in an <img> for portability.
 */

import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from "react";
import QRCode from "qrcode";

import { Modal, ModalFooter } from "./Modal";
import { apiAuth } from "../lib/api-client";
import { redact } from "../lib/auth";
import { clipboardSuccessDetail, writeClipboardText } from "../lib/clipboard";
import { useShownOnceSecretLifecycle } from "../hooks/useShownOnceSecretLifecycle";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import { toast } from "./Toast";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after the user finishes the recovery-codes acknowledgement. */
  onEnrolled: () => void;
}

type Step = "enroll" | "verify" | "recovery" | "error";

interface RecoveryCodesStepProps {
  ackSaved: boolean;
  onAcknowledge: () => void;
  onCopyCodes: () => Promise<void>;
  recoveryCodes: string[];
  setAckSaved: (saved: boolean) => void;
}

function RecoveryCodesStep({
  ackSaved,
  onAcknowledge,
  onCopyCodes,
  recoveryCodes,
  setAckSaved,
}: RecoveryCodesStepProps): ReactElement {
  return (
    <>
      <div className="totp-recovery">
        <p className="muted">
          Save these recovery codes in a safe place. Each one can be used ONCE
          to sign in if you lose access to your authenticator app.
        </p>
        <div className="totp-codes mono">
          {recoveryCodes.map((code) => (
            <div key={code} className="totp-code">
              {code}
            </div>
          ))}
        </div>
        <div className="totp-recovery-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void onCopyCodes()}
          >
            Copy all
          </button>
        </div>
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            cursor: "pointer",
            marginTop: 8,
            fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={ackSaved}
            onChange={(event) => setAckSaved(event.target.checked)}
          />
          <span id="totp-recovery-acknowledgement">
            I saved my recovery codes somewhere safe
          </span>
        </label>
      </div>
      <ModalFooter>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onAcknowledge}
          aria-disabled={!ackSaved || undefined}
          aria-describedby={
            !ackSaved ? "totp-recovery-acknowledgement" : undefined
          }
        >
          I&apos;ve saved these — finish
        </button>
      </ModalFooter>
    </>
  );
}

export function TotpSetupModal({
  open,
  onClose,
  onEnrolled,
}: Props): ReactElement | null {
  const [step, setStep] = useState<Step>("enroll");
  const [busy, setBusy] = useState<boolean>(false);
  const [otpauth, setOtpauth] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState<string>("");
  const [error, setError] = useState<string>("");
  // Recovery-codes acknowledgement. The codes are shown exactly once
  // (the server stores hashes only), so the modal refuses to dismiss
  // — Esc, backdrop, ✕ — until the operator confirms they saved them.
  const [ackSaved, setAckSaved] = useState<boolean>(false);
  const operationOptions = useMemo(
    () => ({
      ownerId: "mfa-enrollment",
      label: "MFA enrollment operation",
      detail: "Wait for MFA enrollment to finish before leaving Moosewave.",
    }),
    [],
  );
  const operation = useSingleFlightOperation(operationOptions);
  const runOperation = operation.run;
  const recoveryLifecycle = useShownOnceSecretLifecycle(
    "mfa-recovery-codes",
    "MFA recovery codes",
    open && step === "recovery" && recoveryCodes.length > 0,
  );

  // On open, kick off /enroll. Reset on close.
  useEffect(() => {
    if (!open) {
      setStep("enroll");
      setOtpauth("");
      setQrDataUrl("");
      setRecoveryCodes([]);
      setCode("");
      setError("");
      setAckSaved(false);
      return;
    }
    let cancelled = false;
    const request = runOperation(async () => {
      const res = await apiAuth.totpEnroll();
      if (res.error) return { res, qrDataUrl: "" };
      try {
        const qrDataUrl = await QRCode.toDataURL(res.data.otpauth_uri, {
          margin: 1,
          width: 224,
        });
        return { res, qrDataUrl };
      } catch {
        // QR fallback: show the secret URI as a copyable string.
        return { res, qrDataUrl: "" };
      }
    });
    if (!request) return;
    setBusy(true);
    void request
      .then(({ res, qrDataUrl: nextQrDataUrl }) => {
        if (cancelled) return;
        if (res.error) {
          setError(redact(res.error.message));
          setStep("error");
          return;
        }
        setOtpauth(res.data.otpauth_uri);
        setRecoveryCodes(res.data.recovery_codes);
        setQrDataUrl(nextQrDataUrl);
        setStep("verify");
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(
          redact(
            lifecycleOperationError(
              caught,
              "Moosewave couldn't start MFA enrollment.",
            ),
          ),
        );
        setStep("error");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, runOperation]);

  const onVerify = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      setError("Enter the 6-digit code from your authenticator app");
      return;
    }
    setError("");
    const request = runOperation(async () => {
      const response = await apiAuth.totpVerify(trimmed);
      if (!response.error) recoveryLifecycle.activate();
      return response;
    });
    if (!request) return;
    setBusy(true);
    let res: Awaited<ReturnType<typeof apiAuth.totpVerify>>;
    try {
      res = await request;
    } catch (caught) {
      setError(
        redact(
          lifecycleOperationError(
            caught,
            "Moosewave couldn't verify the authenticator code.",
          ),
        ),
      );
      return;
    } finally {
      setBusy(false);
    }
    if (res.error) {
      setError(redact(res.error.message));
      return;
    }
    setStep("recovery");
  };

  const onCopyCodes = async (): Promise<void> => {
    // Await the clipboard write before claiming success — in Tauri the
    // promise can reject (permissions, focus loss) and toasting early
    // would tell the user their codes are safe when they aren't.
    const result = await writeClipboardText(recoveryCodes.join("\n"), {
      contentClass: "secret",
      label: "MFA recovery codes",
      clearIfUnchangedAfterMs: 60_000,
    });
    if (result.ok) {
      toast.success({
        message: "Recovery codes copied to clipboard",
        detail: clipboardSuccessDetail(result),
      });
    } else toast.error(result.message);
  };

  const onAcknowledge = (): void => {
    if (!ackSaved) return;
    // Release every in-memory copy before parent callbacks can unmount or
    // navigate away. The server retains only hashes.
    recoveryLifecycle.resolve();
    setAckSaved(true);
    setRecoveryCodes([]);
    setOtpauth("");
    setQrDataUrl("");
    setCode("");
    onEnrolled();
    onClose();
  };

  /* Esc / backdrop / ✕ funnel through here. At the recovery step the
   * enrollment is already durable server-side, so a silent dismissal
   * would lose the codes forever AND desync the parent (onEnrolled
   * never fires). Block until acknowledged; once acknowledged a close
   * is equivalent to finishing. */
  const handleClose = (): void => {
    if (busy || operation.active) return;
    if (step === "recovery") {
      if (!ackSaved) return;
      onAcknowledge();
      return;
    }
    onClose();
  };

  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={handleClose}
      closeOnBackdrop={!busy && !operation.active}
      closeOnEscape={!busy && !operation.active}
      title="Set up 2-step verification"
      description="Scan the QR with an authenticator app, then enter the 6-digit code to confirm."
    >
      {step === "verify" ? (
        <form onSubmit={(e) => void onVerify(e)} noValidate>
          <div className="totp-setup">
            <div className="totp-qr">
              {qrDataUrl ? (
                // The img element is a tightly-bounded data: URL; safe.
                <img src={qrDataUrl} alt="" width={224} height={224} />
              ) : (
                <div className="totp-qr-fallback mono">{otpauth}</div>
              )}
            </div>
            <div className="totp-hint">
              Can&apos;t scan? Enter this secret manually:
              <code className="mono totp-secret">{readSecret(otpauth)}</code>
            </div>
            <div className="field">
              <label className="label" htmlFor="totp-code">
                6-digit code
              </label>
              <input
                id="totp-code"
                type="text"
                className="input mono"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="123456"
                inputMode="numeric"
                maxLength={6}
              />
            </div>
            {error ? (
              <div className="auth-error" role="alert">
                {error}
              </div>
            ) : null}
          </div>
          <ModalFooter>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleClose}
              disabled={busy || operation.active}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || operation.active || code.length !== 6}
            >
              {busy ? "Verifying…" : "Verify and enable"}
            </button>
          </ModalFooter>
        </form>
      ) : null}

      {step === "recovery" ? (
        <RecoveryCodesStep
          ackSaved={ackSaved}
          onAcknowledge={onAcknowledge}
          onCopyCodes={onCopyCodes}
          recoveryCodes={recoveryCodes}
          setAckSaved={setAckSaved}
        />
      ) : null}

      {step === "error" ? (
        <>
          <p className="auth-error" role="alert">
            {error || "Couldn't start enrollment."}
          </p>
          <ModalFooter>
            <button
              type="button"
              className="btn"
              onClick={handleClose}
              disabled={busy || operation.active}
            >
              Close
            </button>
          </ModalFooter>
        </>
      ) : null}

      {step === "enroll" ? <p className="muted">Preparing…</p> : null}
    </Modal>
  );
}

/** Pull the base32 secret out of an otpauth URI for manual entry. */
function readSecret(uri: string): string {
  try {
    const u = new URL(uri);
    return u.searchParams.get("secret") || "";
  } catch {
    return "";
  }
}
