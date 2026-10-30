import { useEffect, useRef, useState } from "react";

import { type FormErrors, useFormErrors } from "../../components/FormField";
import {
  apiAuth,
  rememberSession,
  type AuthLoginNeedsWorkspace,
  type AuthMeResponse,
  type AuthOAuthProvider,
} from "../../lib/api-client";
import type { ApiErr } from "../../lib/api/result";
import {
  beginMagicAuthReturnFlow,
  clearPendingMagicAuthReturnState,
  desktopMagicAuthReturnUrl,
} from "../../lib/auth-flow-state";
import { tauriApi } from "../../lib/tauri";
import { signInMfaStep, type SignInMfaStep } from "./signInMfa";
import {
  useDeviceSessionSignIn,
  type DeviceSessionSignInState,
} from "./useDeviceSessionSignIn";

export interface SignInController {
  email: string;
  password: string;
  busy: boolean;
  magicSent: boolean;
  needsWorkspace: AuthLoginNeedsWorkspace | null;
  pickedWorkspace: string;
  needsMfa: boolean;
  needsMfaEnrollment: boolean;
  googleAvailable: boolean;
  oauthPending: boolean;
  deviceSignIn: DeviceSessionSignInState;
  errors: FormErrors;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  chooseWorkspace: (tenantId: string) => void;
  submit: () => Promise<void>;
  sendMagicLink: () => Promise<void>;
  startOAuth: (provider: AuthOAuthProvider) => Promise<void>;
  cancelOAuth: () => void;
  startDeviceSignIn: () => Promise<void>;
  cancelDeviceSignIn: () => Promise<void>;
  showSignInMethods: () => void;
  useDifferentAccount: () => void;
  completeMfa: () => void;
  completeMfaEnrollment: () => void;
  cancelMfa: () => Promise<void>;
}

const INVALID_CREDENTIALS_COPY = "Email or password is incorrect.";

function isInvalidCredentials(error: ApiErr["error"]): boolean {
  return (
    error.status === 401 ||
    error.code === "invalid_credentials" ||
    error.code === "invalid_login"
  );
}

function signInFailureCopy(error: ApiErr["error"]): string {
  if (error.status === 429 || error.code === "rate_limited") {
    return "Too many sign-in attempts. Wait a few minutes and try again.";
  }
  if (error.kind === "timeout") {
    return "Sign-in timed out. Check your connection and try again.";
  }
  if (error.kind === "network") {
    return "Moosewave couldn't connect. Check your connection and try again.";
  }
  if (
    error.kind === "parse" ||
    error.kind === "invalid_config" ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return "Moosewave is temporarily unavailable. Try again shortly.";
  }
  return "Moosewave couldn't sign you in. Check your details and try again.";
}

function magicLinkFailureCopy(error: ApiErr["error"]): string {
  if (error.status === 429 || error.code === "rate_limited") {
    return "Too many link requests. Wait a few minutes and try again.";
  }
  if (error.kind === "timeout") {
    return "The link request timed out. Check your connection and try again.";
  }
  if (error.kind === "network") {
    return "Moosewave couldn't connect. Check your connection and try again.";
  }
  return "Moosewave couldn't send the sign-in link. Try again.";
}

function useGoogleAvailability(activeRef: React.RefObject<boolean>): boolean {
  const [available, setAvailable] = useState(false);
  const requestRef = useRef(0);
  useEffect(() => {
    const requestId = ++requestRef.current;
    void (async () => {
      const next = await apiAuth.oauthIsAvailable("google");
      if (!activeRef.current || requestId !== requestRef.current) return;
      setAvailable(next);
    })();
    return () => {
      if (requestRef.current === requestId) requestRef.current += 1;
    };
  }, [activeRef]);
  return available;
}

export function useSignInController(options: {
  onSignedIn: () => void;
}): SignInController {
  const [email, setEmailState] = useState("");
  const [password, setPasswordState] = useState("");
  const [busy, setBusy] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [needsWorkspace, setNeedsWorkspace] =
    useState<AuthLoginNeedsWorkspace | null>(null);
  const [pickedWorkspace, setPickedWorkspace] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [needsMfaEnrollment, setNeedsMfaEnrollment] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const errors = useFormErrors();
  const activeRef = useRef(false);
  const actionRef = useRef(0);
  const focusRef = useRef(0);
  const mutationRef = useRef(false);
  const pendingSessionRef = useRef<AuthMeResponse | null>(null);
  const pendingMfaRef = useRef(false);
  const onSignedInRef = useRef(options.onSignedIn);
  onSignedInRef.current = options.onSignedIn;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      actionRef.current += 1;
      focusRef.current += 1;
      mutationRef.current = false;
      pendingSessionRef.current = null;
      pendingMfaRef.current = false;
    };
  }, []);

  const googleAvailable = useGoogleAvailability(activeRef);

  const beginAction = (): number | null => {
    if (mutationRef.current) return null;
    mutationRef.current = true;
    const requestId = ++actionRef.current;
    setBusy(true);
    return requestId;
  };
  const isCurrent = (requestId: number): boolean =>
    activeRef.current && requestId === actionRef.current;
  const finishAction = (requestId: number): boolean => {
    if (!isCurrent(requestId)) return false;
    mutationRef.current = false;
    setBusy(false);
    return true;
  };
  const stopOAuthProbe = (): void => {
    focusRef.current += 1;
    setOauthPending(false);
    clearPendingMagicAuthReturnState();
  };

  const stageMfa = (
    me: AuthMeResponse | null,
    step: Exclude<SignInMfaStep, "none">,
  ): void => {
    pendingSessionRef.current = me;
    pendingMfaRef.current = true;
    setNeedsMfa(step === "challenge");
    setNeedsMfaEnrollment(step === "enroll");
  };

  const deviceSession = useDeviceSessionSignIn({
    onSessionVerified: (me) => {
      rememberSession(me);
      onSignedInRef.current();
    },
    onMfaRequired: stageMfa,
  });

  useEffect(() => {
    if (!oauthPending || needsMfa) {
      focusRef.current += 1;
      return;
    }
    const onFocus = (): void => {
      const requestId = ++focusRef.current;
      void (async () => {
        const me = await apiAuth.getAuthMe();
        if (!activeRef.current || requestId !== focusRef.current) return;
        const mfaStep = signInMfaStep(me);
        if (mfaStep !== "none") {
          stageMfa(me.data ?? null, mfaStep);
          clearPendingMagicAuthReturnState();
          setOauthPending(false);
          return;
        }
        if (!me.data) return;
        clearPendingMagicAuthReturnState();
        setOauthPending(false);
        rememberSession(me.data);
        onSignedInRef.current();
      })();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      focusRef.current += 1;
    };
  }, [oauthPending, needsMfa]);

  const submit = async (): Promise<void> => {
    if (mutationRef.current) return;
    errors.clear();
    const submittedEmail = email.trim();
    const validationErrors: Record<string, string> = {};
    if (!submittedEmail) {
      validationErrors.email = "Enter your email address.";
    }
    if (!password) {
      validationErrors.password = "Enter your password.";
    }
    if (Object.keys(validationErrors).length > 0) {
      errors.setMany(validationErrors);
      return;
    }
    stopOAuthProbe();
    const requestId = beginAction();
    if (requestId == null) return;
    const response = await apiAuth.login({
      email: submittedEmail,
      password,
      workspace_id: pickedWorkspace || undefined,
    });
    if (!isCurrent(requestId)) return;
    setEmailState(submittedEmail);
    if (response.error) {
      finishAction(requestId);
      if (isInvalidCredentials(response.error)) {
        setPasswordState("");
        errors.set("password", INVALID_CREDENTIALS_COPY);
      } else {
        errors.set("_form", signInFailureCopy(response.error));
      }
      return;
    }
    if ("needs_workspace" in response.data) {
      finishAction(requestId);
      setPickedWorkspace("");
      setNeedsWorkspace(response.data);
      return;
    }
    setPasswordState("");
    const me = await apiAuth.getAuthMe();
    if (!isCurrent(requestId)) return;
    const mfaStep = signInMfaStep(me);
    if (mfaStep !== "none") {
      stageMfa(me.data ?? null, mfaStep);
      finishAction(requestId);
      return;
    }
    if (me.error || !me.data) {
      finishAction(requestId);
      errors.set(
        "_form",
        me.error
          ? signInFailureCopy(me.error)
          : "Moosewave couldn't verify your session. Sign in again.",
      );
      return;
    }
    rememberSession(me.data);
    finishAction(requestId);
    onSignedInRef.current();
  };

  const sendMagicLink = async (): Promise<void> => {
    if (mutationRef.current) return;
    errors.clear();
    const submittedEmail = email.trim();
    if (!submittedEmail) {
      errors.set("email", "Enter your email address.");
      return;
    }
    stopOAuthProbe();
    const requestId = beginAction();
    if (requestId == null) return;
    let state: string;
    try {
      state = beginMagicAuthReturnFlow();
    } catch {
      finishAction(requestId);
      errors.set("_form", "Unable to start a secure sign-in flow. Try again.");
      return;
    }
    const response = await apiAuth.magicLinkStart(submittedEmail, state);
    if (!isCurrent(requestId)) return;
    finishAction(requestId);
    if (response.error) {
      errors.set("_form", magicLinkFailureCopy(response.error));
      return;
    }
    setEmailState(submittedEmail);
    setMagicSent(true);
  };

  const startOAuth = async (provider: AuthOAuthProvider): Promise<void> => {
    if (mutationRef.current || oauthPending) return;
    errors.clear();
    const requestId = beginAction();
    if (requestId == null) return;
    try {
      const returnUrl = desktopMagicAuthReturnUrl(beginMagicAuthReturnFlow());
      const url = apiAuth.oauthStartUrl(provider, returnUrl);
      setOauthPending(true);
      await tauriApi.openUrl(url);
      finishAction(requestId);
    } catch {
      if (!isCurrent(requestId)) return;
      clearPendingMagicAuthReturnState();
      setOauthPending(false);
      finishAction(requestId);
      errors.set("_form", "Unable to open the secure sign-in page. Try again.");
    }
  };

  const cancelMfa = async (): Promise<void> => {
    const requestId = beginAction();
    if (requestId == null) return;
    pendingMfaRef.current = false;
    await apiAuth.logoutSession();
    if (!finishAction(requestId)) return;
    pendingSessionRef.current = null;
    rememberSession(null);
    setEmailState("");
    setPasswordState("");
    setPickedWorkspace("");
    setNeedsWorkspace(null);
    setNeedsMfa(false);
    setNeedsMfaEnrollment(false);
  };

  return {
    email,
    password,
    busy,
    magicSent,
    needsWorkspace,
    pickedWorkspace,
    needsMfa,
    needsMfaEnrollment,
    googleAvailable,
    oauthPending,
    deviceSignIn: deviceSession.state,
    errors,
    setEmail: (value) => {
      if (mutationRef.current) return;
      setEmailState(value);
      if (errors.get("email")) errors.clear("email");
      if (errors.get("_form")) errors.clear("_form");
      if (errors.get("password") === INVALID_CREDENTIALS_COPY) {
        errors.clear("password");
      }
    },
    setPassword: (value) => {
      if (mutationRef.current) return;
      setPasswordState(value);
      if (errors.get("password")) errors.clear("password");
      if (errors.get("_form")) errors.clear("_form");
    },
    chooseWorkspace: (tenantId) => {
      if (!mutationRef.current) setPickedWorkspace(tenantId);
    },
    submit,
    sendMagicLink,
    startOAuth,
    cancelOAuth: () => {
      if (!mutationRef.current) stopOAuthProbe();
    },
    startDeviceSignIn: async () => {
      if (mutationRef.current || oauthPending) return;
      errors.clear();
      stopOAuthProbe();
      await deviceSession.start();
    },
    cancelDeviceSignIn: deviceSession.cancel,
    showSignInMethods: () => {
      if (mutationRef.current) return;
      errors.clear();
      setMagicSent(false);
    },
    useDifferentAccount: () => {
      if (mutationRef.current) return;
      setNeedsWorkspace(null);
      setPickedWorkspace("");
      setEmailState("");
      setPasswordState("");
      errors.clear();
    },
    completeMfa: () => {
      if (!activeRef.current || mutationRef.current || !pendingMfaRef.current)
        return;
      pendingMfaRef.current = false;
      const pending = pendingSessionRef.current;
      pendingSessionRef.current = null;
      if (pending) rememberSession(pending);
      setNeedsMfa(false);
      setNeedsMfaEnrollment(false);
      onSignedInRef.current();
    },
    completeMfaEnrollment: () => {
      if (!activeRef.current || mutationRef.current || !pendingMfaRef.current)
        return;
      pendingMfaRef.current = false;
      const pending = pendingSessionRef.current;
      pendingSessionRef.current = null;
      if (pending) {
        rememberSession({
          ...pending,
          totp_enabled: true,
          mfa_required: true,
          mfa_satisfied: true,
        });
      }
      setNeedsMfa(false);
      setNeedsMfaEnrollment(false);
      onSignedInRef.current();
    },
    cancelMfa,
  };
}
