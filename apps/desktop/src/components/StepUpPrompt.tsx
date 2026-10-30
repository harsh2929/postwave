/**
 * StepUpPrompt — the dialog a step-up challenge raises INSTEAD OF a logout.
 *
 * Mounted once in the app shell. It listens for `STEP_UP_PROMPT_EVENT`, claims
 * the prompt (see `StepUpPromptDetail.claim` in @postwave/step-up — an
 * unclaimed challenge gives up immediately rather than hanging the request),
 * takes a live authenticator code, and reports back so the transport can retry
 * the original request with its original method, body and Idempotency-Key.
 *
 * It shows the SERVER's sentence. `Requirement.Reason` is written for the
 * person and lives next to the policy it explains ("Confirm it's you before
 * exporting subscriber data."); re-deriving copy from the action id here would
 * be the second, drifting half of a rule that exists once on purpose. The
 * action id is shown alongside it so what is being authorised is never left
 * implicit.
 *
 * THE VERB IS totpVerify, NOT totpChallenge. `MfaChallenge` in this same folder
 * calls `/totp/challenge`, which is correct for ITS job (a login-time gate) and
 * wrong for this one: that handler short-circuits with 200 `{already:true}`
 * whenever the session is already MFA-satisfied — which is exactly the state a
 * step-up challenge describes (satisfied, but `mfa_satisfied_at` is stale). It
 * would report success without moving the clock, the retry would be challenged
 * again, and only the transport's one-shot guard would stop the loop.
 * `/totp/verify` calls MarkSessionMFASatisfied unconditionally. The visible
 * consequence is that a recovery code cannot refresh a step-up proof, so this
 * dialog does not offer one.
 */

import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { apiAuth } from "../lib/api-client";
import { redact } from "../lib/auth";
import {
  STEP_UP_PROMPT_EVENT,
  formatStepUpAction,
  type StepUpChallenge,
  type StepUpPromptDetail,
} from "../lib/step-up";
import { Modal, ModalFooter } from "./Modal";

const OTP_LEN = 6;

interface OpenPrompt {
  challenge: StepUpChallenge;
  settle: (proved: boolean) => void;
}

export function StepUpPrompt(): ReactElement | null {
  const [prompt, setPrompt] = useState<OpenPrompt | null>(null);
  /* Focused from an effect rather than with `autoFocus`, which jsx-a11y
   * forbids app-wide. Same pattern as MfaChallenge's OTP cells. */
  const codeRef = useRef<HTMLInputElement | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onChallenge = (event: Event): void => {
      const detail = (event as CustomEvent<StepUpPromptDetail>).detail;
      if (!detail || typeof detail.claim !== "function") return;
      if (!detail.claim()) return;
      setCode("");
      setError(null);
      setBusy(false);
      setPrompt({
        challenge: detail.challenge,
        // Wrapped, not passed by reference: `settle` is a method on the
        // detail object and must keep its own `this` when it is stored and
        // called later.
        settle: (proved: boolean) => detail.settle(proved),
      });
    };
    window.addEventListener(STEP_UP_PROMPT_EVENT, onChallenge);
    return () => window.removeEventListener(STEP_UP_PROMPT_EVENT, onChallenge);
  }, []);

  /* A prompt left unsettled is a request that never resolves. Unmounting
   * mid-prompt (a window close, an error boundary) must answer "no" rather than
   * silently drop the question. */
  const promptRef = useRef<OpenPrompt | null>(null);
  promptRef.current = prompt;
  useEffect(() => {
    return () => promptRef.current?.settle(false);
  }, []);

  useEffect(() => {
    if (prompt) codeRef.current?.focus();
  }, [prompt]);

  const dismiss = useCallback(() => {
    setPrompt((current) => {
      current?.settle(false);
      return null;
    });
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (!prompt || busy) return;
    const submitted = code.trim();
    if (submitted.length < OTP_LEN) {
      setError(`Enter all ${OTP_LEN} digits`);
      return;
    }
    setError(null);
    setBusy(true);
    const res = await apiAuth.totpVerify(submitted);
    setBusy(false);
    if (res.error) {
      if (res.error.code === "not_enrolled") {
        setError(
          "This action needs two-factor authentication, which isn't set up on your account. Add an authenticator in Settings → Security, then try again.",
        );
        return;
      }
      /* Wipe the field on failure so the next attempt starts from a fresh
       * rotating code rather than the one that just expired. */
      setCode("");
      setError(redact(res.error.message));
      return;
    }
    setCode("");
    setPrompt(null);
    prompt.settle(true);
  }, [busy, code, prompt]);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    void submit();
  }

  if (!prompt) return null;
  const actionLabel = formatStepUpAction(prompt.challenge.action);
  return (
    <Modal
      open
      onClose={dismiss}
      title="Confirm it's you"
      description={prompt.challenge.reason}
      size="sm"
      role="alertdialog"
      /* An outside click here would cancel a sensitive action the user
       * deliberately started; make dismissal explicit. */
      closeOnBackdrop={false}
      closeDisabled={busy}
    >
      <form onSubmit={onSubmit} noValidate>
        {actionLabel ? (
          <p className="muted small">
            Action: <span className="mono">{actionLabel}</span>
          </p>
        ) : null}
        <div className="field-v2">
          <label className="field-v2-label" htmlFor="step-up-code">
            Authentication code
          </label>
          <input
            id="step-up-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            ref={codeRef}
            className="input mono"
            value={code}
            maxLength={OTP_LEN}
            disabled={busy}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, "").slice(0, OTP_LEN));
              if (error) setError(null);
            }}
          />
          <p className="muted small">
            Enter the 6-digit code from your authenticator app. Recovery codes
            can&apos;t be used to confirm a sensitive action.
          </p>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={dismiss}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Confirming…" : "Confirm"}
          </button>
        </ModalFooter>
      </form>
      <p className="muted small">
        You&apos;re still signed in. This only confirms you&apos;re still here
        before a sensitive action.
      </p>
    </Modal>
  );
}
