import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import { FieldError, FormField } from "../../components/FormField";
import { Icon } from "../../components/Icon";
import { LegalLinks } from "../../components/LegalLinks";
import { OAuthButton } from "../../components/OAuthButton";
import type { SignInController } from "./useSignInController";

export type SignInMethod = "password" | "magic";

function SignInMethodSelector({
  method,
  disabled,
  onChange,
}: {
  method: SignInMethod;
  disabled: boolean;
  onChange: (method: SignInMethod) => void;
}): ReactElement {
  return (
    <fieldset className="auth-method-switch" disabled={disabled}>
      <legend className="sr-only">Sign-in method</legend>
      <label
        className={`auth-method-option${method === "password" ? " is-active" : ""}`}
      >
        <input
          type="radio"
          name="sign-in-method"
          value="password"
          checked={method === "password"}
          onChange={() => onChange("password")}
        />
        <Icon name="lock" size={16} className="auth-glyph" />
        Password
      </label>
      <label
        className={`auth-method-option${method === "magic" ? " is-active" : ""}`}
      >
        <input
          type="radio"
          name="sign-in-method"
          value="magic"
          checked={method === "magic"}
          onChange={() => onChange("magic")}
        />
        <Icon name="mail" size={16} className="auth-glyph" />
        Email link
      </label>
    </fieldset>
  );
}

function OAuthPendingNotice({
  onCancel,
  disabled,
}: {
  onCancel: () => void;
  disabled: boolean;
}): ReactElement {
  return (
    <div className="auth-oauth-status" role="status" aria-busy={disabled}>
      <span className="auth-oauth-status-icon" aria-hidden="true">
        <Icon name="shield-check" size={18} className="auth-glyph" />
      </span>
      <span className="auth-oauth-status-copy">
        <strong>Finish signing in with Google</strong>
        <span>Complete the browser step, then return to Moosewave.</span>
      </span>
      <button
        type="button"
        className="auth-link-v2"
        aria-label="Cancel Google sign-in"
        onClick={onCancel}
        disabled={disabled}
      >
        Cancel
      </button>
    </div>
  );
}

export function SignInCredentialsForm({
  controller,
  method,
  onMethodChange,
  onForgotPassword,
}: {
  controller: SignInController;
  method: SignInMethod;
  onMethodChange: (method: SignInMethod) => void;
  onForgotPassword: (email: string) => void;
}): ReactElement {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const focusInvalidRef = useRef(false);
  const googleRowRef = useRef<HTMLDivElement>(null);
  const restoreGoogleFocusRef = useRef(false);
  const emailError = controller.errors.get("email");
  const passwordError = controller.errors.get("password");
  const formError = controller.errors.get("_form");
  const navigationLocked = controller.busy || controller.oauthPending;

  const selectMethod = (nextMethod: SignInMethod): void => {
    if (nextMethod === method || navigationLocked) return;
    setPasswordVisible(false);
    setCapsLockOn(false);
    controller.errors.clear();
    onMethodChange(nextMethod);
  };

  useEffect(() => {
    if (!controller.password) setPasswordVisible(false);
  }, [controller.password]);

  useEffect(() => {
    const hidePassword = (): void => setPasswordVisible(false);
    window.addEventListener("blur", hidePassword);
    return () => window.removeEventListener("blur", hidePassword);
  }, []);

  useEffect(() => {
    if (!focusInvalidRef.current || (!emailError && !passwordError)) return;
    focusInvalidRef.current = false;
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"]')
      ?.focus();
  }, [emailError, passwordError]);

  useEffect(() => {
    if (
      !restoreGoogleFocusRef.current ||
      controller.busy ||
      controller.oauthPending
    ) {
      return;
    }
    restoreGoogleFocusRef.current = false;
    googleRowRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [controller.busy, controller.oauthPending, formError]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    focusInvalidRef.current = true;
    setPasswordVisible(false);
    setCapsLockOn(false);
    void (method === "magic"
      ? controller.sendMagicLink()
      : controller.submit());
  };

  const updateCapsLock = (event: KeyboardEvent<HTMLInputElement>): void => {
    setCapsLockOn(event.getModifierState("CapsLock"));
  };

  return (
    <>
      {controller.googleAvailable ? (
        <>
          <div className="auth-oauth-row-v2" ref={googleRowRef}>
            <OAuthButton
              provider="google"
              onClick={() => {
                setPasswordVisible(false);
                setCapsLockOn(false);
                restoreGoogleFocusRef.current = true;
                void controller.startOAuth("google");
              }}
              disabled={navigationLocked}
            />
          </div>
          <div className="auth-divider-v2">
            <span>or sign in with email</span>
          </div>
        </>
      ) : null}

      {controller.oauthPending ? (
        <OAuthPendingNotice
          onCancel={() => {
            restoreGoogleFocusRef.current = true;
            controller.cancelOAuth();
          }}
          disabled={controller.busy}
        />
      ) : null}

      <SignInMethodSelector
        method={method}
        disabled={navigationLocked}
        onChange={selectMethod}
      />

      <form
        ref={formRef}
        className="auth-credentials-form"
        onSubmit={submit}
        noValidate
        aria-busy={controller.busy}
      >
        <FormField
          label="Email"
          htmlFor="auth-email"
          error={emailError}
          startAdornment={<Icon name="mail" size={18} className="auth-glyph" />}
        >
          <input
            id="auth-email"
            name="email"
            type="email"
            className="input"
            value={controller.email}
            onChange={(event) => controller.setEmail(event.target.value)}
            placeholder="name@company.com"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="email"
            aria-invalid={Boolean(emailError)}
            disabled={navigationLocked}
            required
          />
        </FormField>

        {method === "password" ? (
          <div className="auth-password-field">
            <FormField
              label="Password"
              htmlFor="auth-password"
              error={passwordError}
              help={capsLockOn ? "Caps Lock is on." : undefined}
              labelAction={
                <button
                  type="button"
                  className="auth-recovery-link"
                  onClick={() => onForgotPassword(controller.email.trim())}
                  disabled={navigationLocked}
                >
                  Forgot password?
                </button>
              }
              startAdornment={
                <Icon name="lock" size={18} className="auth-glyph" />
              }
              endAdornment={
                <button
                  type="button"
                  className="auth-password-toggle"
                  aria-label={
                    passwordVisible ? "Hide password" : "Show password"
                  }
                  aria-pressed={passwordVisible}
                  aria-controls="auth-password"
                  onClick={() => setPasswordVisible((visible) => !visible)}
                  disabled={navigationLocked}
                >
                  <Icon
                    name={passwordVisible ? "eye-off" : "eye"}
                    size={18}
                    className="auth-glyph"
                  />
                </button>
              }
            >
              <input
                id="auth-password"
                name="password"
                type={passwordVisible ? "text" : "password"}
                className="input"
                value={controller.password}
                onChange={(event) => controller.setPassword(event.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={Boolean(passwordError)}
                disabled={navigationLocked}
                onKeyDown={updateCapsLock}
                onKeyUp={updateCapsLock}
                onBlur={() => setCapsLockOn(false)}
                required
              />
            </FormField>
          </div>
        ) : null}

        {formError ? (
          <div className="auth-form-alert">
            <FieldError>{formError}</FieldError>
          </div>
        ) : null}

        <button
          type="submit"
          className="btn btn-primary auth-submit-v2"
          disabled={navigationLocked}
        >
          {controller.busy ? (
            <span className="auth-submit-v2-spinner" aria-hidden="true" />
          ) : null}
          <span>
            {controller.busy
              ? method === "magic"
                ? "Sending link…"
                : "Signing in…"
              : method === "magic"
                ? "Send sign-in link"
                : "Sign in"}
          </span>
          {!controller.busy ? (
            <Icon name="arrow-right" size={18} className="auth-glyph" />
          ) : null}
        </button>
      </form>

      <div className="auth-device-entry">
        <div className="auth-divider-v2">
          <span>or approve from another device</span>
        </div>
        <button
          type="button"
          className="btn auth-device-entry-button"
          onClick={() => void controller.startDeviceSignIn()}
          disabled={navigationLocked}
        >
          <Icon name="shield-check" size={18} className="auth-glyph" />
          Sign in with another device
        </button>
      </div>
    </>
  );
}

export function SignInCredentialsFooter({
  disabled,
  onCreateAccount,
  onUseApiKey,
}: {
  disabled: boolean;
  onCreateAccount: () => void;
  onUseApiKey: () => void;
}): ReactElement {
  return (
    <footer className="auth-credentials-footer">
      <div className="auth-account-callout">
        <strong>New to Moosewave?</strong>
        <button
          type="button"
          className="auth-create-account"
          onClick={onCreateAccount}
          disabled={disabled}
        >
          Create account
          <Icon name="arrow-right" size={16} className="auth-glyph" />
        </button>
      </div>

      <div className="auth-credentials-meta">
        <button
          type="button"
          className="auth-api-key-link"
          onClick={onUseApiKey}
          disabled={disabled}
        >
          <Icon name="key" size={16} className="auth-glyph" />
          Set up with an API key
        </button>
        <LegalLinks align="right" />
      </div>
    </footer>
  );
}
