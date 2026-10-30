// SPDX-License-Identifier: AGPL-3.0-only
//
// Real /signup page. Replaces the legacy redirect stub.
//
// Captures email + password + workspace name + workspace slug. The slug auto-
// derives from the workspace name (lowercase, hyphens) but the user can
// override before submit. Backend rejects 409 on slug collisions; we surface
// that inline so the user can pick a different one without losing their other
// inputs.
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import { genericAuthErrorMessage } from "@/lib/auth-errors";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-strength";
import {
  signup,
  oauthStartUrl,
  checkWorkspaceSlug,
  googleSignupInfo,
  completeGoogleSignup,
  type GoogleSignupInfo,
} from "@/lib/auth-api";
import { track } from "@/lib/telemetry";
import { AuthShell } from "@/components/auth/auth-shell";
import { GoogleIcon } from "@/components/auth/google-icon";
import { PasswordStrengthMeter } from "@/components/auth/password-strength-meter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export default function SignupPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [googleIdentity, setGoogleIdentity] = useState<GoogleSignupInfo | null>(
    null,
  );
  const [authMode, setAuthMode] = useState<
    "loading" | "password" | "google" | "expired"
  >("loading");
  // AUTH-015: advisory slug-availability feedback while typing.
  const [slugStatus, setSlugStatus] = useState<
    "idle" | "checking" | "available" | "taken"
  >("idle");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("from") !== "oauth") {
      setAuthMode("password");
      return;
    }
    let active = true;
    void googleSignupInfo()
      .then((identity) => {
        if (!active) return;
        setGoogleIdentity(identity);
        setEmail(identity.email);
        setAuthMode("google");
      })
      .catch(() => {
        if (active) setAuthMode("expired");
      });
    return () => {
      active = false;
    };
  }, []);

  // AUTH-015: debounced availability probe. Only fires for a valid slug shape;
  // an AbortController drops stale in-flight responses so the last keystroke
  // wins. Advisory only — submit still trusts the 409.
  useEffect(() => {
    if (workspaceSlug === "" || !SLUG_PATTERN.test(workspaceSlug)) {
      setSlugStatus("idle");
      return;
    }
    setSlugStatus("checking");
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void checkWorkspaceSlug(workspaceSlug, { signal: controller.signal })
        .then((res) => setSlugStatus(res.available ? "available" : "taken"))
        .catch(() => {
          // Aborted or network error: stay silent (never block signup on the probe).
          if (!controller.signal.aborted) setSlugStatus("idle");
        });
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [workspaceSlug]);

  function onWorkspaceNameChange(v: string) {
    setWorkspaceName(v);
    if (!slugTouched) {
      setWorkspaceSlug(slugify(v));
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (authMode !== "password" && authMode !== "google") return;
    if (!SLUG_PATTERN.test(workspaceSlug)) {
      setError("Workspace slug must be a-z, 0-9, hyphen, 1–40 chars.");
      return;
    }
    if (authMode === "password" && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setSubmitting(true);
    // Telemetry: fire on submit-start so we can compute funnel drop-off
    // even when the network round-trip fails. NO email / workspace
    // name / password is captured — we only signal that the user got
    // past client-side validation.
    track("forge_signup_started", {
      method: googleIdentity ? "google" : "email_password",
    });
    try {
      if (googleIdentity) {
        await completeGoogleSignup({
          workspace_name: workspaceName,
          workspace_slug: workspaceSlug,
          csrf_token: googleIdentity.csrf_token,
        });
      } else
        await signup({
          email,
          password,
          workspace_name: workspaceName,
          workspace_slug: workspaceSlug,
        });
      // Onboarding flow doesn't exist yet — drop straight into /app. Replace
      // with /app/onboarding once the onboarding sub-route lands.
      router.push("/app");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (googleIdentity && (err.status === 401 || err.status === 403)) {
          setAuthMode("expired");
          setGoogleIdentity(null);
          return;
        }
        if (googleIdentity && err.code === "identity_link_required") {
          setError(
            "An account already exists for this Google identity. Sign in to continue.",
          );
          return;
        }
        if (err.status === 409) {
          setError("That workspace slug is taken. Try a different one.");
          return;
        }
        if (err.status === 429) {
          setError("Too many attempts; try again in a few minutes.");
          return;
        }
      }
      // 5xx / body-less / transport failures → friendly message, never the raw
      // ApiError "POST … failed: 500" string (AUTH-011).
      const msg = genericAuthErrorMessage(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const slugInvalid = workspaceSlug !== "" && !SLUG_PATTERN.test(workspaceSlug);

  return (
    <AuthShell
      footer={
        <>
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle as="h1">Create your workspace</CardTitle>
          <CardDescription>
            {authMode === "google"
              ? "You're signed in with Google. Name your workspace to get started."
              : "Sign up for Moosewave. We'll spin up your workspace in seconds."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {authMode === "loading" ? (
            <p role="status">Checking your sign-in…</p>
          ) : null}
          {authMode === "expired" ? (
            <p role="alert">
              Your Google sign-in has expired or could not be verified. Continue
              with Google again to create your workspace.
            </p>
          ) : null}
          {authMode === "password" || authMode === "google" ? (
            <form
              onSubmit={onSubmit}
              className="space-y-4"
              aria-busy={submitting || undefined}
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  readOnly={authMode === "google"}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                />
              </div>
              {authMode === "password" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <PasswordInput
                    id="password"
                    autoComplete="new-password"
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    aria-describedby="password-strength"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={submitting}
                  />
                  <PasswordStrengthMeter
                    password={password}
                    helperId="password-strength"
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Google is your sign-in method. You don&rsquo;t need a
                  password.
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="workspace-name">Workspace name</Label>
                <Input
                  id="workspace-name"
                  required
                  value={workspaceName}
                  onChange={(e) => onWorkspaceNameChange(e.target.value)}
                  disabled={submitting}
                  placeholder="Acme Newsletter"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workspace-slug">Workspace slug</Label>
                <Input
                  id="workspace-slug"
                  required
                  value={workspaceSlug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setWorkspaceSlug(e.target.value);
                  }}
                  disabled={submitting}
                  placeholder="acme"
                  pattern="[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?"
                />
                <p
                  className={`text-xs ${
                    slugInvalid ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  a-z, 0-9, hyphen, 1–40 chars.
                </p>
                {/* AUTH-015: advisory availability feedback. */}
                {!slugInvalid && slugStatus !== "idle" ? (
                  <p
                    className={`text-xs ${
                      slugStatus === "taken"
                        ? "text-destructive"
                        : slugStatus === "available"
                          ? "text-success"
                          : "text-muted-foreground"
                    }`}
                    role="status"
                    aria-live="polite"
                    data-testid="slug-availability"
                  >
                    {slugStatus === "checking"
                      ? "Checking availability…"
                      : slugStatus === "available"
                        ? "✓ Available"
                        : "That workspace slug is taken."}
                  </p>
                ) : null}
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={submitting || slugInvalid}
              >
                {submitting ? "Creating workspace…" : "Create workspace"}
              </Button>
            </form>
          ) : null}

          {authMode === "password" ? (
            <>
              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>
            </>
          ) : null}

          {authMode === "password" || authMode === "expired" ? (
            <div className="space-y-2">
              <Button
                asChild
                type="button"
                variant="outline"
                className="w-full"
              >
                <a href={oauthStartUrl("google")}>
                  <GoogleIcon />
                  Continue with Google
                </a>
              </Button>
            </div>
          ) : null}

          {/*
            The notice the mobile sign-up has carried all along
            (apps/mobile/app/(auth)/sign-up.tsx) and this page never did.

            Two obligations meet here. GDPR Art. 13 requires the privacy notice
            "at the time when personal data are obtained", and this is that
            moment — the form takes an email address. The Terms set an 18+
            floor (legal/terms §3) which, stated only inside a document nobody
            is pointed at, is a floor the user is never actually asked to meet.

            Placed below both sign-up controls so it covers the email form and
            the Google hand-off equally; putting it inside the form would leave
            the OAuth path uncovered.
          */}
          <p className="text-xs text-muted-foreground text-center">
            By creating a workspace you confirm you are at least 18 years old
            and agree to Moosewave&rsquo;s{" "}
            <Link href="/legal/terms" className="underline">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/legal/privacy" className="underline">
              Privacy Policy
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </AuthShell>
  );
}
