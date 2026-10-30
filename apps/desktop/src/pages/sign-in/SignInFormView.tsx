import {
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useRef,
} from "react";

import { AuthShell } from "../../components/AuthShell";
import { FieldError } from "../../components/FormField";
import { MfaChallenge } from "../../components/MfaChallenge";
import { TotpSetupModal } from "../../components/TotpSetupModal";
import { AUTH_SHOWCASE_SLIDES } from "../../lib/auth-showcase";
import { AUTH_ASSETS } from "../../lib/authAssets";
import {
  SignInCredentialsFooter,
  SignInCredentialsForm,
  type SignInMethod,
} from "./SignInCredentialsForm";
import { DeviceSessionSignInView } from "./DeviceSessionSignInView";
import type { SignInController } from "./useSignInController";

export type { SignInMethod } from "./SignInCredentialsForm";

interface Props {
  controller: SignInController;
  onSwitchToSignUp: () => void;
  onUseApiKey: () => void;
  onForgotPassword: (email: string) => void;
  method: SignInMethod;
  onMethodChange: (method: SignInMethod) => void;
}

function submit(event: FormEvent, action: () => Promise<void>): void {
  event.preventDefault();
  void action();
}

function MagicSentView({
  controller,
  onUseDifferentMethod,
}: {
  controller: SignInController;
  onUseDifferentMethod: () => void;
}): ReactElement {
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    statusRef.current?.focus();
  }, []);

  return (
    <AuthShell
      tone="blush"
      illustration={AUTH_ASSETS.magicSent}
      asideEyebrow="Check your inbox"
      asideHeadline="On the way."
      asideSub="Sign-in links expire in five minutes. If you don't see it, check spam — it comes from Moosewave."
      heading="Check your email"
      headingSub={`If an account exists for ${controller.email}, you'll receive a one-time sign-in link. It expires in five minutes.`}
    >
      <div
        ref={statusRef}
        className="auth-state-card"
        role="status"
        tabIndex={-1}
      >
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
        {controller.errors.get("_form") ? (
          <FieldError>{controller.errors.get("_form")}</FieldError>
        ) : null}
        <button
          type="button"
          className="btn btn-primary auth-submit-v2"
          onClick={() => void controller.sendMagicLink()}
          disabled={controller.busy}
        >
          {controller.busy ? "Sending another link…" : "Send another link"}
        </button>
        <button
          type="button"
          className="btn"
          style={{ width: "100%" }}
          onClick={() => {
            controller.showSignInMethods();
            onUseDifferentMethod();
          }}
          disabled={controller.busy}
        >
          Use another sign-in method
        </button>
      </div>
    </AuthShell>
  );
}

function MfaCancellationView(): ReactElement {
  return (
    <AuthShell
      tone="blue"
      illustration={AUTH_ASSETS.magicReturn}
      asideEyebrow="Two-factor verification"
      asideHeadline="Ending this attempt."
      asideSub="Moosewave is revoking the partial session before returning to sign in."
      heading="Signing out"
      headingSub="Please wait while we safely end this sign-in attempt."
    >
      <div className="auth-state-card" role="status" aria-busy="true">
        Ending sign-in session…
      </div>
    </AuthShell>
  );
}

function MfaEnrollmentView({
  controller,
}: {
  controller: SignInController;
}): ReactElement {
  const completedRef = useRef(false);
  return (
    <>
      <AuthShell
        tone="blue"
        illustration={AUTH_ASSETS.magicReturn}
        asideEyebrow="Workspace security"
        asideHeadline="Protect this account."
        asideSub="Your workspace requires two-factor verification before this session can continue."
        heading="Set up two-factor verification"
        headingSub="Enroll an authenticator app to finish signing in."
      >
        <div className="auth-state-card" role="status">
          Complete the secure setup dialog to continue.
        </div>
      </AuthShell>
      <TotpSetupModal
        open
        onEnrolled={() => {
          completedRef.current = true;
          controller.completeMfaEnrollment();
        }}
        onClose={() => {
          if (!completedRef.current) void controller.cancelMfa();
        }}
      />
    </>
  );
}

function moveWorkspaceFocus(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
): void {
  if (
    ![
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ].includes(event.key)
  ) {
    return;
  }
  const choices = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]',
    ) ?? [],
  );
  if (choices.length === 0) return;
  const target =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? choices.length - 1
        : (index +
            (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) +
            choices.length) %
          choices.length;
  event.preventDefault();
  choices[target]?.focus();
  choices[target]?.click();
}

function WorkspaceView({
  controller,
}: {
  controller: SignInController;
}): ReactElement {
  const workspaces = controller.needsWorkspace?.workspaces ?? [];
  return (
    <AuthShell
      tone="blue"
      illustration={AUTH_ASSETS.signin}
      asideEyebrow="Multiple workspaces"
      asideHeadline="Pick where you're heading."
      asideSub="You're a member of more than one workspace. Choose one to continue — you can switch later from the sidebar."
      heading="Choose a workspace"
      headingSub={`Signed in as ${controller.email}`}
    >
      <form onSubmit={(event) => submit(event, controller.submit)} noValidate>
        <div
          className="auth-ws-picker"
          role="radiogroup"
          aria-label="Choose a workspace"
        >
          {workspaces.map((workspace, index) => {
            const selected = controller.pickedWorkspace === workspace.tenant_id;
            return (
              <button
                key={workspace.tenant_id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={
                  selected || (!controller.pickedWorkspace && index === 0)
                    ? 0
                    : -1
                }
                className={`auth-ws-option${selected ? " is-selected" : ""}`}
                onClick={() => controller.chooseWorkspace(workspace.tenant_id)}
                onKeyDown={(event) => moveWorkspaceFocus(event, index)}
                disabled={controller.busy}
              >
                <div className="auth-ws-option-name">
                  <span>{workspace.email}</span>
                  <span className="auth-ws-option-tenant">
                    {workspace.tenant_id}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {controller.errors.get("_form") ? (
          <FieldError>{controller.errors.get("_form")}</FieldError>
        ) : null}
        <button
          type="submit"
          className="btn btn-primary auth-submit-v2"
          disabled={controller.busy || !controller.pickedWorkspace}
          style={{ marginTop: 14 }}
        >
          {controller.busy ? (
            <span className="auth-submit-v2-spinner" aria-hidden="true" />
          ) : null}
          {controller.busy ? "Continuing…" : "Continue"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "100%", marginTop: 8 }}
          onClick={controller.useDifferentAccount}
          disabled={controller.busy}
        >
          Use a different account
        </button>
      </form>
    </AuthShell>
  );
}

function CredentialsView({
  controller,
  onSwitchToSignUp,
  onUseApiKey,
  onForgotPassword,
  method,
  onMethodChange,
}: Props): ReactElement {
  const navigationLocked = controller.busy || controller.oauthPending;
  return (
    <AuthShell
      tone="mint"
      illustration={AUTH_ASSETS.signin}
      showcaseSlides={AUTH_SHOWCASE_SLIDES}
      mainVariant="credentials"
      heading={
        method === "magic" ? "Get a sign-in link" : "Sign in to Moosewave"
      }
      headingSub={
        method === "magic"
          ? "Enter your email. If an account exists, we'll send a one-time link that expires in five minutes."
          : "Use your password, or get a sign-in link by email."
      }
      footer={
        <SignInCredentialsFooter
          disabled={navigationLocked}
          onCreateAccount={onSwitchToSignUp}
          onUseApiKey={onUseApiKey}
        />
      }
    >
      <SignInCredentialsForm
        controller={controller}
        method={method}
        onMethodChange={onMethodChange}
        onForgotPassword={onForgotPassword}
      />
    </AuthShell>
  );
}

export function SignInFormView(props: Props): ReactElement {
  if (props.controller.needsMfaEnrollment) {
    if (props.controller.busy) return <MfaCancellationView />;
    return <MfaEnrollmentView controller={props.controller} />;
  }
  if (props.controller.needsMfa) {
    if (props.controller.busy) return <MfaCancellationView />;
    return (
      <MfaChallenge
        onSatisfied={props.controller.completeMfa}
        onCancel={() => void props.controller.cancelMfa()}
      />
    );
  }
  if (props.controller.deviceSignIn.phase !== "idle") {
    return (
      <DeviceSessionSignInView
        state={props.controller.deviceSignIn}
        onCancel={props.controller.cancelDeviceSignIn}
        onRetry={props.controller.startDeviceSignIn}
      />
    );
  }
  if (props.controller.magicSent) {
    return (
      <MagicSentView
        controller={props.controller}
        onUseDifferentMethod={() => props.onMethodChange("password")}
      />
    );
  }
  if (props.controller.needsWorkspace) {
    return <WorkspaceView controller={props.controller} />;
  }
  return <CredentialsView {...props} />;
}
