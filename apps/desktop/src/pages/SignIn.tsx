/**
 * SignIn — primary email + password auth surface, plus magic-link and
 * OAuth alternatives. Tab-switches with SignUp; same split-screen
 * shell, different submit copy.
 *
 * Boot flow context: this page replaces Welcome as the default first-
 * run screen. The "I have an API key" link at the bottom routes to the
 * legacy Welcome flow for power users / automation accounts.
 *
 * Google is the only release-enabled OAuth provider. Authentication
 * passkeys are not advertised because the API has no WebAuthn contract;
 * the UI must not imply a capability the deployment cannot complete.
 */

import { type ReactElement, useState } from "react";

import { SignInFormView, type SignInMethod } from "./sign-in/SignInFormView";
import { useSignInController } from "./sign-in/useSignInController";
import { SignUp } from "./SignUp";

interface Props {
  /** Called after a successful sign-in (cookie set + /me cached). */
  onSignedIn: () => void;
  /** Click "I have an API key" → fall back to the legacy setup flow. */
  onUseApiKey: () => void;
  /** Click "Forgot password" → the reset screen, preserving entered email. */
  onForgotPassword: (email: string) => void;
  /** Recovery links can land directly on the matching email-link form. */
  initialMethod?: SignInMethod;
}

type Mode = "signin" | "signup";
export type { SignInMethod } from "./sign-in/SignInFormView";

export function SignIn(props: Props): ReactElement {
  const [mode, setMode] = useState<Mode>("signin");
  const [method, setMethod] = useState<SignInMethod>(
    props.initialMethod ?? "password",
  );
  if (mode === "signup") {
    return (
      <SignUp
        onSignedIn={props.onSignedIn}
        onSwitchToSignIn={() => setMode("signin")}
      />
    );
  }
  return (
    <SignInControllerBoundary
      {...props}
      method={method}
      onMethodChange={setMethod}
      onSwitchToSignUp={() => setMode("signup")}
    />
  );
}

function SignInControllerBoundary({
  onSignedIn,
  onUseApiKey,
  onForgotPassword,
  onSwitchToSignUp,
  method,
  onMethodChange,
}: Props & {
  onSwitchToSignUp: () => void;
  method: SignInMethod;
  onMethodChange: (method: SignInMethod) => void;
}): ReactElement {
  const controller = useSignInController({ onSignedIn });
  return (
    <SignInFormView
      controller={controller}
      method={method}
      onMethodChange={onMethodChange}
      onSwitchToSignUp={onSwitchToSignUp}
      onUseApiKey={onUseApiKey}
      onForgotPassword={onForgotPassword}
    />
  );
}
