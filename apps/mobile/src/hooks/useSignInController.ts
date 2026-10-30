/**
 * useSignInController — everything the sign-in screen KNOWS and DOES.
 *
 * WHY (MAP#53). `app/(auth)/sign-in.tsx` was a 630-line module that held the
 * form state, three async credential pathways, the focus/announcement policy
 * and the layout in one function. Desktop had already split the same screen
 * into `useSignInController` + two views (apps/desktop/src/pages/sign-in/),
 * leaving `SignIn.tsx` an 81-line shell. This is the mobile counterpart, so
 * the route file is now a state → view switch and nothing else.
 *
 * THE SPLIT, and where each kind of decision lives:
 *
 *   lib/signInForm.ts  — per-field verdicts and what the button says.
 *   lib/signInFlow.ts  — the ORDER the refusals fire in, and the base-URL
 *                        verdict. Both are pure and covered by node tests.
 *   THIS FILE          — state, focus, VoiceOver announcements and the view
 *                        model. It consumes the pure modules and never
 *                        re-decides anything they already decided.
 *   hooks/signInPathways — the async I/O: prepare → login → /me, and the
 *                        magic-link request. Split out so this file stays
 *                        readable and inside the 450-line source budget.
 *   components/auth/*  — presentation only.
 *
 * The three pathways are unchanged:
 *
 *   1. Email + password → POST /api/v1/auth/login. The backend sets a
 *      pw_session cookie; we then GET /me, persist the profile and route to
 *      the destination. A `needs_workspace` answer renders a picker step
 *      before completing.
 *   2. Magic link → POST /api/v1/auth/magic-link/start. The backend always
 *      202s (no account enumeration), so the UI shows "check your email" and
 *      waits for `moosewave://auth/magic`.
 *   3. Google → useGoogleSignIn owns the browser round-trip and hands the
 *      callback to /(auth)/magic-return.
 *
 * MOUNT DISCIPLINE. Every submit awaits at least twice (prepare → login →
 * /me). Without the `mounted` ref a user who backgrounds or navigates away
 * mid-request lands a setState on an unmounted tree, and — worse — a stale
 * response can re-enable a button on a screen that no longer exists.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Text, TextInput } from "react-native";

import type { AuthLoginNeedsWorkspace } from "@/api/auth";
import {
  requestMagicLink,
  submitPassword,
  type SignInRuntime,
} from "@/hooks/signInPathways";
import { useGoogleSignIn, type GoogleSignIn } from "@/hooks/useGoogleSignIn";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useResendCooldown } from "@/hooks/useResendCooldown";
import { announce, announceScreenChange } from "@/lib/a11y";
import { readLastBaseUrl } from "@/lib/authPrefs";
import { DEFAULT_API_BASE_URL, normalizeApiBaseUrl } from "@/lib/config";
import {
  AUTO_SIGN_IN_OFFLINE_GRACE_MS,
  claimAutoSignInAttempt,
  DEV_AUTO_SIGN_IN,
} from "@/lib/devAutoSignIn";
import { traceAutoSignIn } from "@/lib/devAutoSignInTrace";
import {
  announcementFor,
  clearFieldError,
  FORM_ERROR_KEY,
  firstInvalidField,
  NO_FIELD_ERRORS,
  setFieldErrors,
  type FieldErrorMap,
} from "@/lib/fieldErrors";
import { haptics } from "@/lib/haptics";
import { type SignInMethod, signInSubmitState } from "@/lib/signInForm";
import { SIGN_IN_FIELD_ORDER } from "@/lib/signInFlow";
import { useAuthStore } from "@/store/auth";

/** What the views need. Nothing here is a react-native element or a style. */
export interface SignInController {
  online: boolean;
  busy: boolean;
  /** The form-level message, "" when there is none. */
  error: string;
  errors: FieldErrorMap;
  magicSent: boolean;
  method: SignInMethod;
  magicMode: boolean;
  submit: ReturnType<typeof signInSubmitState>;
  authWarning: string | null;
  localCleanupPending: boolean;
  baseUrl: string;
  apiFieldExpanded: boolean;
  email: string;
  password: string;
  needsWorkspace: AuthLoginNeedsWorkspace | null;
  pickedWorkspace: string;
  resendSeconds: number;
  google: GoogleSignIn;
  refs: {
    email: RefObject<TextInput | null>;
    password: RefObject<TextInput | null>;
    magicHeading: RefObject<Text | null>;
    pickerHeading: RefObject<Text | null>;
  };
  /** exactOptionalPropertyTypes: an absent caption is a MISSING prop. */
  fieldError: (key: string) => { error?: string };
  onChangeBaseUrl: (value: string) => void;
  onToggleApiField: () => void;
  onChangeEmail: (value: string) => void;
  onChangePassword: (value: string) => void;
  onChangeMethod: (next: SignInMethod) => void;
  onSelectWorkspace: (tenantId: string) => void;
  /** The primary button: password submit or link request, per method. */
  onSubmitPrimary: () => void;
  /** Return key on the email field: send the link, or move to password. */
  onEmailSubmitEditing: () => void;
  onSendMagicLink: () => void;
  onUseAnotherMethod: () => void;
  onRetryCleanup: () => void;
  /**
   * Dismiss a warning that carries no retry.
   *
   * Not every authWarning is actionable: a sign-out whose SERVER revocation
   * failed sets one with `localCleanupPending: false`
   * (store/authSignIn.ts cancelAuthSession), so the strip renders without its
   * retry button and the user has read it, understood it, and has no way to
   * put it down. The store has always exported `clearAuthWarning` for exactly
   * this and nothing called it.
   */
  onDismissWarning: () => void;
}

export function useSignInController(): SignInController {
  const online = useIsOnline();
  const signInSession = useAuthStore((s) => s.signInSession);
  const authWarning = useAuthStore((s) => s.authWarning);
  const localCleanupPending = useAuthStore((s) => s.localCleanupPending);
  const retryLocalCleanup = useAuthStore((s) => s.retryLocalCleanup);
  const clearAuthWarning = useAuthStore((s) => s.clearAuthWarning);
  const prepare = useAuthStore((s) => s.prepareForSessionAuthentication);

  // Normalised like DEFAULT_API_BASE_URL is: a hand-edited .env can carry a
  // trailing slash, and an un-normalised seed would differ from the same
  // address typed by hand.
  const [baseUrl, setBaseUrl] = useState(
    DEV_AUTO_SIGN_IN
      ? normalizeApiBaseUrl(DEV_AUTO_SIGN_IN.baseUrl)
      : DEFAULT_API_BASE_URL,
  );
  const [apiFieldExpanded, setApiFieldExpanded] = useState(false);
  const [email, setEmail] = useState(DEV_AUTO_SIGN_IN?.email ?? "");
  const [password, setPassword] = useState(DEV_AUTO_SIGN_IN?.password ?? "");
  const [busy, setBusy] = useState(false);
  // Keyed, not a single string: a form-level line at the bottom of a scrolled
  // form under an open keyboard says something is wrong and never says where.
  const [errors, setErrors] = useState<FieldErrorMap>(NO_FIELD_ERRORS);
  const [magicSent, setMagicSent] = useState(false);
  const [method, setMethod] = useState<SignInMethod>("password");
  const [needsWorkspace, setNeedsWorkspace] =
    useState<AuthLoginNeedsWorkspace | null>(null);
  const [pickedWorkspace, setPickedWorkspace] = useState("");
  const resend = useResendCooldown();

  const emailRef = useRef<TextInput | null>(null);
  const passwordRef = useRef<TextInput | null>(null);
  const magicHeadingRef = useRef<Text | null>(null);
  const pickerHeadingRef = useRef<Text | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Self-hosted operators typed their server address again after every
  // sign-out. The address is not a credential, so it survives sign-out.
  useEffect(() => {
    // An auto sign-in build carries the address it is meant to reach, and this
    // read resolves LATER than the first paint — without the guard the stored
    // address from a previous install lands on top of it and the auto attempt
    // goes to the wrong host. That is not hypothetical: it is how a stale LAN
    // address survived a reinstall and hung sign-in on a dead subnet.
    if (DEV_AUTO_SIGN_IN) return;
    let cancelled = false;
    void readLastBaseUrl().then((stored) => {
      if (!cancelled && stored) setBaseUrl(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Whatever the form ends up saying is the outcome of the auto attempt — a
  // refusal that never reached the network looks identical to one that did.
  useEffect(() => {
    const message = errors[FORM_ERROR_KEY];
    if (message) traceAutoSignIn("formError", { message });
  }, [errors]);

  // VoiceOver: swapping between three full-screen trees inside one route
  // otherwise changes the screen silently, leaving focus on a dead button.
  useEffect(() => {
    if (magicSent) announceScreenChange("Check your email", magicHeadingRef);
  }, [magicSent]);
  useEffect(() => {
    if (needsWorkspace) announceScreenChange("Pick a workspace", pickerHeadingRef);
  }, [needsWorkspace]);

  /**
   * Report validation failures. Focus moves to the first invalid control in
   * visual order and exactly ONE message is announced — announcing all of them
   * produces an unparseable run-on.
   */
  const failFields = useCallback(
    (next: Record<string, string | undefined>): void => {
      if (!mounted.current) return;
      const merged = setFieldErrors(NO_FIELD_ERRORS, next);
      haptics.error();
      setErrors(merged);
      const focusKey = firstInvalidField(merged, SIGN_IN_FIELD_ORDER);
      if (focusKey === "email") emailRef.current?.focus();
      else if (focusKey === "password") passwordRef.current?.focus();
      announce(announcementFor(merged, SIGN_IN_FIELD_ORDER));
    },
    [],
  );

  const fail = useCallback(
    (message: string): void => failFields({ [FORM_ERROR_KEY]: message }),
    [failFields],
  );

  /** A base-URL problem must reveal the collapsed field it refers to. */
  const failBaseUrl = useCallback(
    (message: string): void => {
      setApiFieldExpanded(true);
      fail(message);
    },
    [fail],
  );

  // The async pathways live at module scope so this hook body stays readable
  // and each stays inside the 300-line function budget. They read live values
  // through a ref, so a value typed after the closure was created still wins.
  const runtimeRef = useRef({} as SignInRuntime);
  runtimeRef.current = {
    email,
    password,
    baseUrl,
    online,
    busy,
    needsWorkspace,
    pickedWorkspace,
    mounted,
    resend,
    prepare,
    signInSession,
    setBusy,
    setErrors,
    setNeedsWorkspace,
    setPickedWorkspace,
    setMagicSent,
    fail,
    failFields,
    failBaseUrl,
  };

  const onSubmitPassword = useCallback((): void => {
    void submitPassword(runtimeRef.current);
  }, []);

  /**
   * Auto sign-in, at most ONCE PER PROCESS (dev builds only — see
   * lib/devAutoSignIn). The fields are already seeded by the useState
   * initialisers above, so this only has to press the button.
   *
   * The latch is the whole safety property, and it lives at module scope for
   * two reasons. `submitPassword` reports failure by setting form state, which
   * re-renders and would otherwise retry forever against a server that is
   * refusing us. And every sign-out in the app returns to a FRESH sign-in
   * screen, so a per-mount guard would sign the developer straight back in and
   * make signing out impossible.
   *
   * Connectivity is a preference, not a precondition: we go as soon as the
   * probe says online, but a probe that is slow or wrong (common on a LAN with
   * no internet route) only delays the attempt by the grace period.
   */
  useEffect(() => {
    // `localCleanupPending` disables the manual button because a previous
    // sign-out could not finish wiping this device. Auto sign-in must respect
    // the same fail-closed state rather than routing around it — signing a new
    // principal in over unwiped data is the exact thing that gate prevents.
    traceAutoSignIn("effect", { online, busy, localCleanupPending, baseUrl });
    if (!DEV_AUTO_SIGN_IN || busy || localCleanupPending) return;
    if (online) {
      if (claimAutoSignInAttempt()) {
        traceAutoSignIn("submit", { via: "online" });
        void submitPassword(runtimeRef.current);
      }
      return;
    }
    const timer = setTimeout(() => {
      // The screen may be gone by now (the user tapped through to the API-key
      // flow while we waited). Submitting then would yank them back.
      if (!mounted.current) return;
      if (claimAutoSignInAttempt()) {
        traceAutoSignIn("submit", { via: "grace" });
        void submitPassword(runtimeRef.current);
      }
    }, AUTO_SIGN_IN_OFFLINE_GRACE_MS);
    return () => clearTimeout(timer);
  }, [online, busy, localCleanupPending, baseUrl]);
  const onSendMagicLink = useCallback((): void => {
    void requestMagicLink(runtimeRef.current);
  }, []);

  const google = useGoogleSignIn({
    baseUrl,
    online,
    prepare,
    onError: fail,
    onBaseUrlError: failBaseUrl,
  });

  // Editing credentials after the picker has appeared means the user is
  // targeting a different account, so the picked tenant_id is now stale.
  // Clearing the caption AND the form line matters: a "wrong password" banner
  // that survives a retype makes the app feel like it isn't listening.
  const editCredential = useCallback(
    (field: "email" | "password", value: string): void => {
      if (field === "email") setEmail(value);
      else setPassword(value);
      setErrors((current) =>
        clearFieldError(clearFieldError(current, field), FORM_ERROR_KEY),
      );
      setNeedsWorkspace((current) => (current ? null : current));
      setPickedWorkspace((current) => (current ? "" : current));
    },
    [],
  );

  /**
   * Switching credential kind clears every error, and has to: a "wrong
   * password" caption has no meaning once the password field is gone, and a
   * keyed `password` error would still be counted by firstInvalidField with no
   * control left to focus.
   */
  function onChangeMethod(next: SignInMethod): void {
    if (next === method) return;
    setMethod(next);
    setErrors(NO_FIELD_ERRORS);
    // A picked workspace belongs to the password submit that produced it.
    setNeedsWorkspace(null);
    setPickedWorkspace("");
  }

  const magicMode = method === "magic";
  return {
    online,
    busy,
    error: errors[FORM_ERROR_KEY] ?? "",
    errors,
    magicSent,
    method,
    magicMode,
    submit: signInSubmitState({
      method,
      busy,
      localCleanupPending,
      resendSeconds: resend.seconds,
      needsWorkspace: needsWorkspace !== null,
      pickedWorkspace,
    }),
    authWarning,
    localCleanupPending,
    baseUrl,
    apiFieldExpanded,
    email,
    password,
    needsWorkspace,
    pickedWorkspace,
    resendSeconds: resend.seconds,
    google,
    refs: {
      email: emailRef,
      password: passwordRef,
      magicHeading: magicHeadingRef,
      pickerHeading: pickerHeadingRef,
    },
    fieldError: (key) => {
      const message = errors[key];
      return message ? { error: message } : {};
    },
    onChangeBaseUrl: (value) => {
      setBaseUrl(value);
      setErrors((current) => clearFieldError(current, FORM_ERROR_KEY));
    },
    onToggleApiField: () => setApiFieldExpanded((v) => !v),
    onChangeEmail: (value) => editCredential("email", value),
    onChangePassword: (value) => editCredential("password", value),
    onChangeMethod,
    onSelectWorkspace: setPickedWorkspace,
    onSubmitPrimary: magicMode ? onSendMagicLink : onSubmitPassword,
    onEmailSubmitEditing: magicMode
      ? onSendMagicLink
      : () => passwordRef.current?.focus(),
    onSendMagicLink,
    onUseAnotherMethod: () => {
      setErrors(NO_FIELD_ERRORS);
      resend.reset();
      setMagicSent(false);
      // "Another method" is literally the password one — returning to a form
      // still in link mode would offer the button they just backed out of.
      setMethod("password");
    },
    onDismissWarning: clearAuthWarning,
    onRetryCleanup: () => {
      setBusy(true);
      void retryLocalCleanup()
        .then((result) => {
          if (!result.complete) {
            fail(
              "Secure cleanup is still unavailable. Unlock the device and try again.",
            );
          }
        })
        .finally(() => setBusy(false));
    },
  };
}
