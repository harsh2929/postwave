// SPDX-License-Identifier: AGPL-3.0-only
//
// Real /login page. Replaces the legacy redirect stub.
//
// Flow:
//   1. User submits email + password → POST /auth/login.
//   2. If the API returns `needs_workspace: true`, swap into a workspace-picker
//      step that re-submits with `workspace_id`. Otherwise router.push('/app').
//
// This page intentionally lives outside the [locale] segment because magic-
// link / verification emails embed deep links and a locale prefix would break
// /login?next=... links shared in support tickets and emails.
"use client";

import { KeyRound, Smartphone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ApiError } from "@/lib/api";
import { genericAuthErrorMessage } from "@/lib/auth-errors";
import { safeNextPath as sharedSafeNextPath } from "@/lib/safe-navigation";
import { asRoute } from "@/lib/typed-routes";
import { login, oauthStartUrl, type WorkspaceSummary } from "@/lib/auth-api";
import { loginWithPasskey, passkeySupported } from "@/lib/auth-passkey";
import { AuthShell } from "@/components/auth/auth-shell";
import { DeviceSignIn } from "@/components/auth/device-sign-in";
import { GoogleIcon } from "@/components/auth/google-icon";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { cn } from "@/lib/utils";

type Stage =
  | { kind: "credentials" }
  | { kind: "device" }
  | { kind: "workspace"; workspaces: WorkspaceSummary[] };

// Above this count the workspace picker gains a search box (AUTH-012).
const WORKSPACE_SEARCH_THRESHOLD = 6;

type RedirectContext = "session_expired" | "continue" | null;

export default function LoginPage() {
  return <LoginInner />;
}

function LoginInner() {
  const router = useRouter();
  // Avoid useSearchParams's page-wide Suspense bailout: it made the tiny
  // “Loading…” fallback the LCP until the complete auth bundle hydrated.
  // `/app` is the safe server/default target; after hydration we adopt a
  // validated same-origin path from the current URL.
  const [next, setNext] = useState("/app");
  const [redirectContext, setRedirectContext] = useState<RedirectContext>(null);
  // SHELL-018: the shell workspace switcher links here with ?workspace=<id> so
  // the picker pre-selects the target workspace after re-auth.
  const [workspaceHint, setWorkspaceHint] = useState("");
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const rawNext = query.get("next");
    const reason = query.get("reason");
    const validatedNext = safeNextPath(rawNext);
    setWorkspaceHint(query.get("workspace")?.trim() ?? "");
    setNext(validatedNext);
    if (rawNext && validatedNext === "/app" && rawNext !== "/app") {
      query.delete("next");
      const scrubbedQuery = query.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${scrubbedQuery ? `?${scrubbedQuery}` : ""}${window.location.hash}`,
      );
    }
    // Explain WHY the user is here (AUTH-022) without ever appearing on a
    // plain, direct /login visit.
    if (reason === "session_expired" || reason === "expired") {
      setRedirectContext("session_expired");
    } else if (rawNext) {
      setRedirectContext("continue");
    }
  }, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // AUTH-024: default off → a shorter browser-session login; opt into a
  // persistent 30-day session.
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "credentials" });
  const [chosenWorkspace, setChosenWorkspace] = useState<string>("");
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const passkeyButtonRef = useRef<HTMLButtonElement>(null);
  const handledPasskeyFocusRequestRef = useRef(0);
  const [passkeyFocusRequest, setPasskeyFocusRequest] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // AUTH-023: only offer the passkey button once we know the browser supports
  // it — a server render can't tell, so this stays false until hydration.
  const [passkeyReady, setPasskeyReady] = useState(false);
  useEffect(() => {
    // Whatever was typed or autofilled while the JS loaded lives only in the
    // DOM: hydration keeps it, but these fields are controlled, so the first
    // re-render would write the empty state back over it. Adopt it first.
    const typedEmail = emailRef.current?.value ?? "";
    const typedPassword = passwordRef.current?.value ?? "";
    if (typedEmail) setEmail(typedEmail);
    if (typedPassword) setPassword(typedPassword);
    setHydrated(true);
    setPasskeyReady(passkeySupported());
  }, []);

  // Run after React commits `disabled=false`; focusing from the async
  // ceremony's `finally` block can otherwise race the button update.
  useEffect(() => {
    if (
      submitting ||
      passkeyFocusRequest === handledPasskeyFocusRequestRef.current
    ) {
      return;
    }
    handledPasskeyFocusRequestRef.current = passkeyFocusRequest;
    passkeyButtonRef.current?.focus();
  }, [passkeyFocusRequest, submitting]);

  // Stage changes replace the primary task in-place. Move programmatic focus
  // to the new heading so keyboard and screen-reader users hear that context
  // immediately; returning to credentials lets the remounted email field's
  // autofocus take over instead.
  useEffect(() => {
    if (stage.kind !== "credentials") stageHeadingRef.current?.focus();
  }, [stage.kind]);

  const chosenWorkspaceVisible =
    stage.kind === "workspace" &&
    stage.workspaces.some(
      (workspace) =>
        workspace.id === chosenWorkspace &&
        workspaceMatchesQuery(workspace, workspaceQuery),
    );

  async function signInWithPasskey() {
    let restoreFocus = false;
    setError(null);
    setSubmitting(true);
    try {
      await loginWithPasskey();
      router.push(asRoute(next));
      router.refresh();
    } catch (err) {
      // A user-cancelled prompt (NotAllowedError/AbortError) is not an error to
      // surface — they simply chose another method.
      if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "AbortError")
      ) {
        restoreFocus = true;
        return;
      }
      handleAuthError(err, setError);
    } finally {
      setSubmitting(false);
      // A native WebAuthn prompt can blur its invoking control, and Chromium
      // also drops focus while that button is disabled. Restore the user's
      // place only for a quiet cancellation, after React re-enables it.
      if (restoreFocus) setPasskeyFocusRequest((request) => request + 1);
    }
  }

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await login({ email, password, remember });
      if ("needs_workspace" in res && res.needs_workspace) {
        setStage({ kind: "workspace", workspaces: res.workspaces });
        // Pre-select the switcher's target workspace (SHELL-018) when it is one
        // of the user's, else fall back to the first.
        const hinted = workspaceHint
          ? res.workspaces.find((w) => w.id === workspaceHint)
          : undefined;
        if (hinted) {
          setChosenWorkspace(hinted.id);
        } else if (res.workspaces[0]) {
          setChosenWorkspace(res.workspaces[0].id);
        }
        return;
      }
      router.push(asRoute(next));
      router.refresh();
    } catch (err) {
      handleAuthError(err, setError);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitWorkspace(e: FormEvent) {
    e.preventDefault();
    if (!chosenWorkspaceVisible) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await login({
        email,
        password,
        workspace_id: chosenWorkspace,
        remember,
      });
      if ("needs_workspace" in res && res.needs_workspace) {
        // Should not happen — surface a generic error.
        setError("Could not complete sign-in. Please try again.");
        return;
      }
      router.push(asRoute(next));
      router.refresh();
    } catch (err) {
      handleAuthError(err, setError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign up
          </Link>
        </>
      }
    >
      <Card
        data-login-hydrated={hydrated ? "true" : "false"}
        aria-busy={!hydrated || undefined}
      >
        <CardHeader>
          <CardTitle
            as="h1"
            ref={stageHeadingRef}
            tabIndex={-1}
            className="outline-none"
          >
            {stage.kind === "credentials"
              ? "Sign in"
              : stage.kind === "device"
                ? "Sign in with another device"
                : "Choose a workspace"}
          </CardTitle>
          <CardDescription>
            {stage.kind === "credentials"
              ? "Welcome back. Sign in to your Moosewave workspace."
              : stage.kind === "device"
                ? "Approve this browser from a phone or computer where you're already signed in."
                : "Your account belongs to multiple workspaces."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {stage.kind === "credentials" && redirectContext ? (
            <RedirectBanner context={redirectContext} next={next} />
          ) : null}
          {stage.kind === "credentials" ? (
            <>
              <form
                onSubmit={submitCredentials}
                className="space-y-4"
                aria-busy={submitting || undefined}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    ref={emailRef}
                    id="email"
                    type="email"
                    autoComplete="email"
                    autoFocus
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password">Password</Label>
                    <Link
                      href="/forgot-password"
                      className="inline-flex min-h-[44px] items-center -my-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      Forgot password?
                    </Link>
                  </div>
                  <PasswordInput
                    ref={passwordRef}
                    id="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <label className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    disabled={submitting}
                  />
                  Keep me signed in
                </label>
                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
                {/* Before hydration there is no submit handler, and a native
                    submission is a GET back to /login that wipes what was
                    typed. Disabling the default button does not stop every
                    browser's Enter-key submission, so until hydration this is
                    not a submit button at all: with no submit button and two
                    text fields, implicit submission does nothing (HTML
                    "implicit submission"). The fields keep no `name`, so even
                    a forced native submit carries no credentials. */}
                <Button
                  type={hydrated ? "submit" : "button"}
                  className="w-full"
                  disabled={submitting || !hydrated}
                >
                  {submitting
                    ? "Signing in…"
                    : hydrated
                      ? "Sign in"
                      : "Preparing sign-in…"}
                </Button>
              </form>

              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>

              <div className="space-y-2">
                <Button
                  asChild
                  type="button"
                  variant="outline"
                  className="w-full"
                >
                  <a href={oauthStartUrl("google", next)}>
                    <GoogleIcon />
                    Sign in with Google
                  </a>
                </Button>
                {passkeyReady ? (
                  <Button
                    ref={passkeyButtonRef}
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={signInWithPasskey}
                    disabled={submitting || !hydrated}
                  >
                    <KeyRound className="size-4" aria-hidden />
                    Sign in with a passkey
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setError(null);
                    setStage({ kind: "device" });
                  }}
                  disabled={submitting || !hydrated}
                >
                  <Smartphone className="size-4" aria-hidden />
                  Sign in with another device
                </Button>
              </div>

              <div className="text-center text-sm text-muted-foreground">
                <Link
                  href="/magic-link"
                  className="inline-flex min-h-[44px] items-center justify-center px-3 underline-offset-4 hover:text-foreground hover:underline"
                >
                  Sign in with magic link
                </Link>
              </div>
            </>
          ) : stage.kind === "device" ? (
            <DeviceSignIn
              remember={remember}
              onBack={() => setStage({ kind: "credentials" })}
              onComplete={() => {
                router.push(asRoute(next));
                router.refresh();
              }}
            />
          ) : (
            <form
              onSubmit={submitWorkspace}
              className="space-y-4"
              aria-busy={submitting || undefined}
            >
              <WorkspacePicker
                workspaces={stage.workspaces}
                chosen={chosenWorkspace}
                onChoose={setChosenWorkspace}
                query={workspaceQuery}
                onQueryChange={setWorkspaceQuery}
                disabled={submitting}
              />
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <div className="flex justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    setWorkspaceQuery("");
                    setStage({ kind: "credentials" });
                  }}
                  disabled={submitting}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={submitting || !chosenWorkspaceVisible}
                >
                  {submitting ? "Signing in…" : "Continue"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthShell>
  );
}

function WorkspacePicker({
  workspaces,
  chosen,
  onChoose,
  query,
  onQueryChange,
  disabled,
}: {
  workspaces: WorkspaceSummary[];
  chosen: string;
  onChoose: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  disabled: boolean;
}) {
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? workspaces.filter((workspace) => workspaceMatchesQuery(workspace, needle))
    : workspaces;

  return (
    <div className="space-y-2">
      {workspaces.length > WORKSPACE_SEARCH_THRESHOLD ? (
        <div>
          <Label htmlFor="workspace-search" className="sr-only">
            Search workspaces
          </Label>
          <Input
            id="workspace-search"
            type="search"
            placeholder="Search workspaces…"
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            disabled={disabled}
          />
        </div>
      ) : null}
      <fieldset className="max-h-72 space-y-2 overflow-y-auto pr-1">
        <legend className="sr-only">Workspaces</legend>
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-5 text-center">
            <p className="text-sm font-medium">No matching workspaces</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try another name or clear the search to see every workspace.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => onQueryChange("")}
            >
              Clear search
            </Button>
          </div>
        ) : (
          filtered.map((ws) => (
            <label
              key={ws.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-[background-color,border-color,box-shadow]",
                chosen === ws.id
                  ? "border-primary/40 bg-accent/70 shadow-[0_0_0_1px_hsl(var(--primary)/0.08)]"
                  : "hover:border-primary/20 hover:bg-accent/40",
              )}
            >
              <input
                type="radio"
                name="workspace"
                className="mt-1 shrink-0"
                value={ws.id}
                checked={chosen === ws.id}
                onChange={(e) => onChoose(e.target.value)}
                disabled={disabled}
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">{ws.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {ws.slug}
                </span>
              </span>
            </label>
          ))
        )}
      </fieldset>
    </div>
  );
}

function workspaceMatchesQuery(
  workspace: WorkspaceSummary,
  rawQuery: string,
): boolean {
  const needle = rawQuery.trim().toLowerCase();
  if (!needle) return true;
  return (
    workspace.name.toLowerCase().includes(needle) ||
    workspace.slug.toLowerCase().includes(needle)
  );
}

function RedirectBanner({
  context,
  next,
}: {
  context: "session_expired" | "continue";
  next: string;
}) {
  return (
    <div
      role="status"
      className="rounded-md border border-info/40 bg-info-subtle px-3 py-2 text-sm text-info"
    >
      {context === "session_expired" ? (
        "Your session expired — please sign in again."
      ) : (
        <>
          Sign in to continue to{" "}
          <span className="font-medium break-all">{next}</span>.
        </>
      )}
    </div>
  );
}

// Login page allows /verify-email in addition to the base /app
// allow-list — completes the email-verification redirect flow when
// a user hits /verify-email/<token> without an active session.
function safeNextPath(value: string | null): string {
  return sharedSafeNextPath(value, {
    extraPrefixes: ["/verify-email", "/cli/auth"],
  });
}

function handleAuthError(err: unknown, setError: (s: string) => void): void {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      // Enumeration-safe: never reveal whether the email exists.
      setError("Invalid email or password.");
      return;
    }
    if (err.status === 429) {
      setError("Too many attempts; try again in a few minutes.");
      return;
    }
  }
  // 5xx / body-less / transport failures → friendly message, never the raw
  // "POST /api/v1/auth/login failed: 500 …" ApiError string (AUTH-011).
  setError(genericAuthErrorMessage(err));
}
