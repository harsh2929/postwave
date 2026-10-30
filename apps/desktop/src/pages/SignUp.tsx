/**
 * SignUp — companion to SignIn. Creates a tenant + owner user + sets a
 * session cookie. Mirrors the same split-screen AuthShell with a
 * "fresh start" illustration on the aside.
 *
 * The backend rule is "≥ 12 char password"; we surface a live
 * 4-item checklist (length / uppercase / number / symbol) so the user
 * knows exactly what to add — not just "weak/strong".
 */

import { type FormEvent, type ReactElement, useEffect, useState } from "react";

import { AuthShell } from "../components/AuthShell";
import { FieldError, FormField, useFormErrors } from "../components/FormField";
import { LegalLinks } from "../components/LegalLinks";
import { OAuthButton } from "../components/OAuthButton";
import {
  PasswordRequirements,
  allPasswordRulesPass,
} from "../components/PasswordRequirements";
import {
  apiAuth,
  rememberSession,
  type AuthOAuthProvider,
} from "../lib/api-client";
import { AUTH_ASSETS } from "../lib/authAssets";
import { LEGAL_URLS } from "../lib/config";
import { redact } from "../lib/auth";
import {
  beginMagicAuthReturnFlow,
  desktopMagicAuthReturnUrl,
} from "../lib/auth-flow-state";
import { tauriApi } from "../lib/tauri";

interface Props {
  onSignedIn: () => void;
  onSwitchToSignIn: () => void;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function suggestSlug(email: string, workspace: string): string {
  const base = workspace.trim() || email.split("@")[0] || "";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function SignUp(props: Props): ReactElement {
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [workspaceName, setWorkspaceName] = useState<string>("");
  const [workspaceSlug, setWorkspaceSlug] = useState<string>("");
  const [slugTouched, setSlugTouched] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const errors = useFormErrors();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const available = await apiAuth.oauthIsAvailable("google");
      if (cancelled) return;
      setGoogleAvailable(available);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onWorkspaceName = (v: string): void => {
    setWorkspaceName(v);
    if (!slugTouched) setWorkspaceSlug(suggestSlug(email, v));
  };

  const onOAuth = async (provider: AuthOAuthProvider): Promise<void> => {
    let returnUrl: string;
    try {
      returnUrl = desktopMagicAuthReturnUrl(beginMagicAuthReturnFlow());
    } catch {
      errors.set("_form", "Unable to start a secure sign-in flow. Try again.");
      return;
    }
    const url = apiAuth.oauthStartUrl(provider, returnUrl);
    await tauriApi.openUrl(url);
  };

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    errors.clear();

    if (!email.trim()) {
      errors.set("email", "Email is required");
      return;
    }
    if (!password) {
      errors.set("password", "Password is required");
      return;
    }
    if (!allPasswordRulesPass(password)) {
      errors.set("password", "Password doesn't meet all requirements yet");
      return;
    }
    if (!workspaceName.trim()) {
      errors.set("workspaceName", "Workspace name is required");
      return;
    }
    const slug = workspaceSlug || suggestSlug(email, workspaceName);
    if (!SLUG_RE.test(slug)) {
      errors.set(
        "workspaceSlug",
        "1–40 chars: lowercase letters, digits, hyphens; no leading/trailing hyphen",
      );
      return;
    }

    setBusy(true);
    const res = await apiAuth.signup({
      email: email.trim(),
      password,
      workspace_name: workspaceName.trim(),
      workspace_slug: slug,
    });
    setBusy(false);
    if (res.error) {
      errors.set("_form", redact(res.error.message));
      return;
    }
    const me = await apiAuth.getAuthMe();
    if (me.data) rememberSession(me.data);
    props.onSignedIn();
  };

  const allRulesOk = allPasswordRulesPass(password);

  return (
    <AuthShell
      tone="blue"
      illustration={AUTH_ASSETS.signup}
      asideEyebrow="Start free"
      asideHeadline="A clean canvas for your sender brand."
      asideSub="Create a workspace, connect your sending identity, and review the safety checks before sending."
      heading="Create your workspace"
      headingSub="Set up your workspace and verify its sending configuration."
      footer={
        <>
          <p
            style={{
              fontSize: 11,
              color: "var(--pw-fg-subtle)",
              margin: "12px 0 0",
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            By signing up you agree to the Moosewave{" "}
            {/* D02-http-auth#13: raw target=_blank anchors are a no-op in the
                Tauri webview and pointed at the wrong host. Route through
                tauriApi.openUrl with the configured LEGAL_URLS, like LegalLinks. */}
            <button
              type="button"
              className="auth-link-v2"
              onClick={() => void tauriApi.openUrl(LEGAL_URLS.terms)}
            >
              Terms of Service
            </button>{" "}
            and{" "}
            <button
              type="button"
              className="auth-link-v2"
              onClick={() => void tauriApi.openUrl(LEGAL_URLS.privacy)}
            >
              Privacy Policy
            </button>
            . We'll send a verification email; you can verify later from
            Settings.
          </p>
          <div className="auth-switch-mode">
            Already have an account?
            <button
              type="button"
              className="auth-switch-mode-link"
              onClick={props.onSwitchToSignIn}
            >
              Sign in
            </button>
          </div>
          <LegalLinks />
        </>
      }
    >
      {googleAvailable ? (
        <>
          <div className="auth-oauth-row-v2">
            <OAuthButton
              provider="google"
              onClick={() => void onOAuth("google")}
              disabled={busy}
            />
          </div>
          <div className="auth-divider-v2">
            <span>or use email</span>
          </div>
        </>
      ) : null}

      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <FormField
          label="Work email"
          htmlFor="su-email"
          required
          error={errors.get("email")}
        >
          <input
            id="su-email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (errors.get("email")) errors.clear("email");
            }}
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
        </FormField>

        <FormField
          label="Password"
          htmlFor="su-password"
          required
          error={errors.get("password")}
        >
          <input
            id="su-password"
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
          label="Workspace name"
          htmlFor="su-ws-name"
          required
          help="Shown to your teammates and in your workspace URL."
          error={errors.get("workspaceName")}
        >
          <input
            id="su-ws-name"
            type="text"
            className="input"
            value={workspaceName}
            onChange={(e) => {
              onWorkspaceName(e.target.value);
              if (errors.get("workspaceName")) errors.clear("workspaceName");
            }}
            placeholder="Acme Co"
            required
          />
        </FormField>

        <FormField
          label="Workspace URL"
          htmlFor="su-ws-slug"
          help="Lowercase letters, digits, and hyphens. Must be unique."
          error={errors.get("workspaceSlug")}
        >
          <div className="auth-slug-row-v2">
            <span className="auth-slug-prefix-v2">app.moosewave.com/</span>
            <input
              id="su-ws-slug"
              type="text"
              className="auth-slug-input-v2"
              value={workspaceSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setWorkspaceSlug(e.target.value);
                if (errors.get("workspaceSlug")) errors.clear("workspaceSlug");
              }}
              placeholder="acme"
              pattern="[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?"
              required
            />
          </div>
        </FormField>

        {errors.get("_form") ? (
          <FieldError>{errors.get("_form")}</FieldError>
        ) : null}

        <button
          type="submit"
          className="btn btn-primary auth-submit-v2"
          disabled={busy || !allRulesOk}
          style={{ marginTop: 12 }}
        >
          {busy ? (
            <span className="auth-submit-v2-spinner" aria-hidden="true" />
          ) : null}
          {busy ? "Creating workspace…" : "Create workspace"}
        </button>
      </form>
    </AuthShell>
  );
}
