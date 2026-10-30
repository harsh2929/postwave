/**
 * signInPathways — the two async credential routines behind the sign-in form.
 *
 * They are here rather than inside `useSignInController` for one reason: they
 * are the part of sign-in with side effects on the device (SecureStore, the
 * network, the session store, navigation) and they read no React state
 * directly. Everything they touch arrives in a `SignInRuntime` value that the
 * controller rebuilds on every render, so a character typed after a closure
 * was created still wins.
 *
 * WHAT THEY DELIBERATELY DO NOT DECIDE. Whether a submit is allowed at all,
 * and which of several simultaneous problems is reported, is `lib/signInFlow`
 * — pure and covered by node tests. These functions only carry a verdict to
 * the surface it belongs on, then do the I/O. That boundary is what makes the
 * ordering testable at all (MAP#53).
 *
 * MOUNT DISCIPLINE. Each routine awaits at least twice, so it re-checks
 * `mounted` before every setState that follows an await. The single exception
 * is `cancelSession` in completeLogin: session teardown must run even on an
 * unmounted screen, because a half-authenticated cookie left alive is worse
 * than a lost message.
 */
import { router } from "expo-router";
import type { RefObject } from "react";

import {
  type AuthApiError,
  type AuthLoginNeedsWorkspace,
  createAuthClient,
  redactAuthError,
} from "@/api/auth";
import type { ResendCooldown } from "@/hooks/useResendCooldown";
import { traceAutoSignIn } from "@/lib/devAutoSignInTrace";
import {
  linkRequestErrorMessage,
  OFFLINE_COPY,
  signInErrorMessage,
} from "@/lib/authErrorCopy";
import {
  signInAuthErrorCode,
  trackSignInCompleted,
} from "@/lib/authFlowTelemetry";
import { mobileAuthLinkStart } from "@/lib/authLinkContract";
import { rememberLastBaseUrl } from "@/lib/authPrefs";
import { NO_FIELD_ERRORS, type FieldErrorMap } from "@/lib/fieldErrors";
import { haptics } from "@/lib/haptics";
import {
  clearPendingMagicLinkState,
  createPendingMagicLinkState,
} from "@/lib/magicLinkState";
import {
  magicLinkPreflight,
  passwordPreflight,
  type SignInPreflight,
  withCleanupSuffix,
  workspaceStep,
} from "@/lib/signInFlow";
import {
  destinationForSession,
  sessionProfileFromMe,
  useAuthStore,
} from "@/store/auth";

/** The live values and effects the two async pathways operate on. */
export interface SignInRuntime {
  email: string;
  password: string;
  baseUrl: string;
  online: boolean;
  busy: boolean;
  needsWorkspace: AuthLoginNeedsWorkspace | null;
  pickedWorkspace: string;
  mounted: RefObject<boolean>;
  resend: ResendCooldown;
  prepare: () => Promise<void>;
  signInSession: ReturnType<typeof useAuthStore.getState>["signInSession"];
  setBusy: (next: boolean) => void;
  setErrors: (next: FieldErrorMap) => void;
  setNeedsWorkspace: (next: AuthLoginNeedsWorkspace | null) => void;
  setPickedWorkspace: (next: string) => void;
  setMagicSent: (next: boolean) => void;
  fail: (message: string) => void;
  failFields: (next: Record<string, string | undefined>) => void;
  failBaseUrl: (message: string) => void;
}

/**
 * Routes a preflight refusal to the right surface. Returns the cleared base
 * URL, or null when the submit must stop here.
 */
function acceptPreflight(
  runtime: SignInRuntime,
  verdict: SignInPreflight,
  method: "password" | "magic_link",
): string | null {
  switch (verdict.kind) {
    case "ready":
      return verdict.baseUrl;
    case "fields":
      runtime.failFields(verdict.problems);
      break;
    case "form":
      runtime.fail(verdict.message);
      break;
    case "offline":
      trackSignInCompleted("failure", method, "offline");
      runtime.fail(OFFLINE_COPY);
      break;
    case "baseUrl":
      runtime.failBaseUrl(verdict.message);
      break;
  }
  return null;
}

function reportApiFailure(
  runtime: SignInRuntime,
  err: AuthApiError,
  method: "password" | "magic_link",
  message: string,
): void {
  trackSignInCompleted("failure", method, signInAuthErrorCode(err));
  if (err.status === 429) runtime.resend.start(err.retryAfterSeconds);
  runtime.fail(message);
}

/**
 * Password sign-in, with a guarantee that the button always comes back.
 *
 * Both call sites invoke this as `void submitPassword(...)`, so a rejection
 * escaping it is swallowed by the runtime and NOTHING resets `busy`. The
 * screen is then a spinner that spins forever with no message and no way out —
 * the user cannot even retry, because the button stays disabled. Only
 * `prepare()` was guarded; every step after it (client construction, the login
 * call, the /me round-trip, persisting the session) could strand the screen.
 *
 * This wrapper makes that structurally impossible: whatever escapes is turned
 * into a visible failure with the button re-enabled.
 */
export async function submitPassword(runtime: SignInRuntime): Promise<void> {
  try {
    await runPasswordSubmit(runtime);
  } catch (err) {
    traceAutoSignIn("submit:threw", {
      message: err instanceof Error ? err.message : String(err),
    });
    if (!runtime.mounted.current) return;
    runtime.setBusy(false);
    runtime.fail(
      redactAuthError(
        err instanceof Error ? err.message : "Sign-in could not be completed",
      ),
    );
  }
}

async function runPasswordSubmit(runtime: SignInRuntime): Promise<void> {
  // The button is disabled while busy, but the password field's return key is
  // not — without this a hardware-keyboard user can queue a second login.
  if (runtime.busy) return;
  runtime.setErrors(NO_FIELD_ERRORS);
  const cleared = acceptPreflight(
    runtime,
    passwordPreflight({
      email: runtime.email,
      password: runtime.password,
      online: runtime.online,
      baseUrl: runtime.baseUrl,
      needsWorkspace: runtime.needsWorkspace !== null,
      pickedWorkspace: runtime.pickedWorkspace,
    }),
    "password",
  );
  if (cleared === null) return;

  runtime.setBusy(true);
  traceAutoSignIn("prepare:start");
  try {
    await runtime.prepare();
    traceAutoSignIn("prepare:done");
  } catch (err) {
    traceAutoSignIn("prepare:threw", {
      message: err instanceof Error ? err.message : String(err),
    });
    if (!runtime.mounted.current) return;
    runtime.setBusy(false);
    runtime.fail(
      redactAuthError(
        err instanceof Error ? err.message : "Secure sign-out is pending",
      ),
    );
    return;
  }
  const api = createAuthClient(cleared);
  traceAutoSignIn("login:start", { baseUrl: cleared });
  const res = await api.login({
    email: runtime.email.trim(),
    password: runtime.password,
    ...(runtime.pickedWorkspace
      ? { workspace_id: runtime.pickedWorkspace }
      : {}),
  });
  traceAutoSignIn("login:done", {
    error: res.error ? String(res.error.status ?? res.error.message) : null,
    mounted: runtime.mounted.current,
  });
  if (!runtime.mounted.current) return;
  if (res.error) {
    runtime.setBusy(false);
    reportApiFailure(
      runtime,
      res.error,
      "password",
      signInErrorMessage(res.error),
    );
    return;
  }
  if ("needs_workspace" in res.data) {
    runtime.setBusy(false);
    applyWorkspaceStep(runtime, res.data.workspaces);
    return;
  }
  try {
    await completeLogin(runtime, api);
  } finally {
    if (runtime.mounted.current) runtime.setBusy(false);
  }
}

function applyWorkspaceStep(
  runtime: SignInRuntime,
  workspaces: AuthLoginNeedsWorkspace["workspaces"],
): void {
  const step = workspaceStep(workspaces);
  if (step.kind === "form") {
    runtime.fail(step.message);
    return;
  }
  runtime.setNeedsWorkspace({
    needs_workspace: true,
    workspaces: step.workspaces,
  });
  runtime.setPickedWorkspace(step.selected);
}

async function completeLogin(
  runtime: SignInRuntime,
  api: ReturnType<typeof createAuthClient>,
): Promise<void> {
  const me = await api.getMe();
  if (me.error || !me.data) {
    // Session teardown runs regardless of mount state — leaving a
    // half-authenticated cookie alive is worse than a lost message.
    await useAuthStore.getState().cancelSession(api.baseUrl);
    trackSignInCompleted("failure", "password", "profile_load_failed");
    runtime.fail(
      me.error ? signInErrorMessage(me.error) : "Couldn't load profile",
    );
    return;
  }
  const profile = sessionProfileFromMe(me.data);
  try {
    await runtime.signInSession({ baseUrl: api.baseUrl, profile });
  } catch (err) {
    // signInSession rejects on an unusable profile (sanitize fail) or a
    // SecureStore write error. Surface it instead of leaving the user on a
    // frozen, still-spinning button.
    trackSignInCompleted("failure", "password", "profile_load_failed");
    runtime.fail(
      redactAuthError(err instanceof Error ? err.message : "Sign-in failed"),
    );
    return;
  }
  void rememberLastBaseUrl(api.baseUrl);
  haptics.success();
  trackSignInCompleted("success", "password", "none");
  router.replace(destinationForSession(profile));
}

export async function requestMagicLink(runtime: SignInRuntime): Promise<void> {
  if (runtime.busy || runtime.resend.seconds > 0) return;
  const cleared = acceptPreflight(
    runtime,
    magicLinkPreflight({
      email: runtime.email,
      online: runtime.online,
      baseUrl: runtime.baseUrl,
    }),
    "magic_link",
  );
  if (cleared === null) return;

  const api = createAuthClient(cleared);
  runtime.setErrors(NO_FIELD_ERRORS);
  runtime.setBusy(true);
  try {
    await runtime.prepare();
    const pending = await createPendingMagicLinkState({
      email: runtime.email.trim(),
      baseUrl: api.baseUrl,
    });
    const res = await api.magicLinkStart(
      runtime.email.trim(),
      mobileAuthLinkStart(pending.state),
    );
    if (res.error) {
      reportApiFailure(
        runtime,
        res.error,
        "magic_link",
        withCleanupSuffix(
          linkRequestErrorMessage(res.error),
          await discardPendingMagicLink(),
        ),
      );
      return;
    }
    void rememberLastBaseUrl(api.baseUrl);
    if (!runtime.mounted.current) return;
    runtime.resend.start();
    runtime.setMagicSent(true);
  } catch (err) {
    runtime.fail(
      withCleanupSuffix(
        redactAuthError(
          err instanceof Error ? err.message : "Magic link failed",
        ),
        await discardPendingMagicLink(),
      ),
    );
  } finally {
    if (runtime.mounted.current) runtime.setBusy(false);
  }
}

/** True when the pending nonce is gone; false when SecureStore refused. */
async function discardPendingMagicLink(): Promise<boolean> {
  try {
    await clearPendingMagicLinkState();
    return true;
  } catch {
    return false;
  }
}
