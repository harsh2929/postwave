import { useCallback, useEffect, useRef, useState } from "react";

import {
  apiAuth,
  type AuthDeviceSessionConfirmResponse,
  type AuthDeviceSessionStartResponse,
  type AuthMeResponse,
} from "../../lib/api-client";
import { isProductionBuild } from "../../lib/config";
import { getDashboardUrl } from "../../lib/dashboard-url";
import { signInMfaStep, type SignInMfaStep } from "./signInMfa";

export type DevicePollAction =
  | "pending"
  | "slow_down"
  | "denied"
  | "expired"
  | "fatal";

export function classifyDevicePollError(code?: string): DevicePollAction {
  switch (code) {
    case "authorization_pending":
      return "pending";
    case "slow_down":
      return "slow_down";
    case "access_denied":
      return "denied";
    case "expired_token":
      return "expired";
    default:
      return "fatal";
  }
}

function isRetryablePollTransport(error: {
  kind?: string;
  status?: number;
}): boolean {
  return (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  );
}

interface DeviceGrantDetails {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalSeconds: number;
}

export type DeviceSessionSignInState =
  | { phase: "idle" }
  | { phase: "starting" }
  | ({
      phase: "waiting" | "network";
      remainingSeconds: number;
    } & DeviceGrantDetails)
  | { phase: "verifying"; connectionIssue: boolean }
  | { phase: "cancelling" }
  | {
      phase: "error";
      reason: "denied" | "expired" | "unavailable";
      message: string;
    };

interface DeviceSessionSignInOptions {
  onSessionVerified: (me: AuthMeResponse) => void;
  onMfaRequired: (
    me: AuthMeResponse | null,
    step: Exclude<SignInMfaStep, "none">,
  ) => void;
}

const DEFAULT_POLL_SECONDS = 5;
const MAX_POLL_SECONDS = 60;
const MAX_CONFIRM_SECONDS = 5 * 60;
const SESSION_VERIFY_SECONDS = 60;
const MAX_URL_BYTES = 4_096;
const MAX_DEVICE_CODE_BYTES = 1_024;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function expectedApprovalOrigin(): string | null {
  try {
    const url = new URL(getDashboardUrl());
    if (
      (url.protocol !== "https:" &&
        !(
          !isProductionBuild() &&
          url.protocol === "http:" &&
          isLoopbackHost(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function containsEncodedSecret(value: string, deviceCode: string): boolean {
  let candidate = value;
  for (let pass = 0; pass < 4; pass += 1) {
    if (candidate.includes(deviceCode)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return false;
    }
  }
  return candidate.includes(deviceCode);
}

function safeVerificationUrl(
  value: unknown,
  expectedOrigin: string,
  complete: boolean,
  userCode: string,
  deviceCode: string,
): string | null {
  if (
    typeof value !== "string" ||
    byteLength(value) > MAX_URL_BYTES ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    containsEncodedSecret(value, deviceCode)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.origin !== expectedOrigin ||
      url.pathname !== "/cli/auth" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    const keys = Array.from(url.searchParams.keys());
    const codes = url.searchParams.getAll("user_code");
    if (
      complete
        ? keys.length !== 1 ||
          keys[0] !== "user_code" ||
          codes.length !== 1 ||
          codes[0] !== userCode
        : url.search !== ""
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function positiveSeconds(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= maximum
    ? Math.floor(value)
    : null;
}

function readDeviceGrant(
  value: AuthDeviceSessionStartResponse,
): { deviceCode: string; details: DeviceGrantDetails } | null {
  const userCode =
    typeof value.user_code === "string"
      ? value.user_code.trim().toUpperCase()
      : "";
  const deviceCode =
    typeof value.device_code === "string" ? value.device_code : "";
  const approvalOrigin = expectedApprovalOrigin();
  if (!approvalOrigin || !deviceCode) return null;
  const verificationUri = safeVerificationUrl(
    value.verification_uri,
    approvalOrigin,
    false,
    userCode,
    deviceCode,
  );
  const verificationUriComplete = safeVerificationUrl(
    value.verification_uri_complete,
    approvalOrigin,
    true,
    userCode,
    deviceCode,
  );
  const expiresIn = positiveSeconds(value.expires_in, 60 * 60);
  const interval =
    positiveSeconds(value.interval, MAX_POLL_SECONDS) ?? DEFAULT_POLL_SECONDS;
  if (
    value.grant_kind !== "session" ||
    value.remember !== false ||
    byteLength(deviceCode) > MAX_DEVICE_CODE_BYTES ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode) ||
    !verificationUri ||
    !verificationUriComplete ||
    !expiresIn
  ) {
    return null;
  }
  return {
    deviceCode,
    details: {
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresAt: Date.now() + expiresIn * 1_000,
      intervalSeconds: interval,
    },
  };
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (elapsed: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    const onAbort = (): void => finish(false);
    const timer = window.setTimeout(() => finish(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function remainingSeconds(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
}

function validConfirmedSession(
  value: AuthDeviceSessionConfirmResponse,
): boolean {
  return (
    value.grant_kind === "session" &&
    value.session === true &&
    value.confirmed === true &&
    value.confirmation_required === false &&
    value.remember === false &&
    positiveSeconds(value.expires_in, 12 * 60 * 60) !== null
  );
}

/**
 * Owns the RFC 8628 target-device lifecycle. The bearer device_code lives
 * only in this hook's closure/ref and is never copied into render state.
 */
export function useDeviceSessionSignIn(options: DeviceSessionSignInOptions): {
  state: DeviceSessionSignInState;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
} {
  const [state, setState] = useState<DeviceSessionSignInState>({
    phase: "idle",
  });
  const mountedRef = useRef(false);
  const flowRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const countdownRef = useRef<number | null>(null);
  const deviceCodeRef = useRef<string | null>(null);
  const sessionIssuedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const clearCountdown = (): void => {
    if (countdownRef.current !== null) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  };

  const isCurrent = (flow: number, signal: AbortSignal): boolean =>
    mountedRef.current && flowRef.current === flow && !signal.aborted;

  const clearRuntime = (): void => {
    clearCountdown();
    deviceCodeRef.current = null;
    requestRef.current = null;
  };

  const fail = (
    flow: number,
    signal: AbortSignal,
    reason: "denied" | "expired" | "unavailable",
    message: string,
  ): void => {
    if (!isCurrent(flow, signal)) return;
    clearRuntime();
    setState({ phase: "error", reason, message });
  };

  const handOffSession = (
    flow: number,
    signal: AbortSignal,
    me: AuthMeResponse | null,
    mfaStep: SignInMfaStep,
  ): void => {
    if (!isCurrent(flow, signal)) return;
    sessionIssuedRef.current = false;
    clearRuntime();
    setState({ phase: "idle" });
    if (mfaStep !== "none") optionsRef.current.onMfaRequired(me, mfaStep);
    else if (me) optionsRef.current.onSessionVerified(me);
  };

  const discardIssuedSession = async (
    flow: number,
    signal: AbortSignal,
    reason: "expired" | "unavailable",
    message: string,
  ): Promise<void> => {
    const deviceCode = deviceCodeRef.current;
    sessionIssuedRef.current = false;
    await Promise.allSettled([
      ...(deviceCode ? [apiAuth.cancelDeviceSessionGrant(deviceCode)] : []),
      apiAuth.logoutSession(),
    ]);
    fail(flow, signal, reason, message);
  };

  const cancelGrantAndFail = async (
    flow: number,
    signal: AbortSignal,
    deviceCode: string,
    reason: "denied" | "expired" | "unavailable",
    message: string,
  ): Promise<void> => {
    await apiAuth.cancelDeviceSessionGrant(deviceCode);
    fail(flow, signal, reason, message);
  };

  const verifyIssuedSession = async (
    flow: number,
    signal: AbortSignal,
    expiresAt: number,
  ): Promise<void> => {
    while (isCurrent(flow, signal) && Date.now() < expiresAt) {
      const me = await apiAuth.getAuthMe(signal);
      if (!isCurrent(flow, signal)) return;
      const mfaStep = signInMfaStep(me);
      if (mfaStep !== "none") {
        handOffSession(flow, signal, me.data ?? null, mfaStep);
        return;
      }
      if (me.data) {
        handOffSession(flow, signal, me.data, "none");
        return;
      }
      if (
        me.error.code !== "aborted" &&
        (me.error.kind === "network" || me.error.kind === "timeout")
      ) {
        setState({ phase: "verifying", connectionIssue: true });
        if (!(await waitForPoll(DEFAULT_POLL_SECONDS * 1_000, signal))) return;
        continue;
      }
      await discardIssuedSession(
        flow,
        signal,
        "unavailable",
        "Approval succeeded, but Moosewave couldn't verify the new session. Start again.",
      );
      return;
    }
    if (isCurrent(flow, signal)) {
      await discardIssuedSession(
        flow,
        signal,
        "expired",
        "The approval completed, but the session could not be verified in time. Start again.",
      );
    }
  };

  const confirmProvisionalSession = async (
    flow: number,
    controller: AbortController,
    deviceCode: string,
    confirmExpiresAt: number,
  ): Promise<void> => {
    const { signal } = controller;
    while (isCurrent(flow, signal) && Date.now() < confirmExpiresAt) {
      const confirmation = await apiAuth.confirmDeviceSessionGrant(
        deviceCode,
        signal,
      );
      if (!isCurrent(flow, signal)) return;
      if (confirmation.data) {
        if (!validConfirmedSession(confirmation.data)) {
          sessionIssuedRef.current = true;
          await discardIssuedSession(
            flow,
            signal,
            "unavailable",
            "Moosewave returned an unexpected confirmation response. Start again.",
          );
          return;
        }
        sessionIssuedRef.current = true;
        clearCountdown();
        setState({ phase: "verifying", connectionIssue: false });
        await verifyIssuedSession(
          flow,
          signal,
          Date.now() + SESSION_VERIFY_SECONDS * 1_000,
        );
        return;
      }
      if (confirmation.error.code === "aborted") return;
      const action = classifyDevicePollError(confirmation.error.code);
      if (action === "denied" || action === "expired") {
        await cancelGrantAndFail(
          flow,
          signal,
          deviceCode,
          action,
          action === "denied"
            ? "The sign-in request was denied before confirmation completed."
            : "The session confirmation expired. Start again to get a new code.",
        );
        return;
      }
      if (!isRetryablePollTransport(confirmation.error)) {
        await cancelGrantAndFail(
          flow,
          signal,
          deviceCode,
          "unavailable",
          "Moosewave couldn't confirm this device sign-in. Start again.",
        );
        return;
      }
      setState({ phase: "verifying", connectionIssue: true });
      const retryMs = Math.min(
        DEFAULT_POLL_SECONDS * 1_000,
        Math.max(0, confirmExpiresAt - Date.now()),
      );
      if (retryMs === 0 || !(await waitForPoll(retryMs, signal))) return;
    }
    if (isCurrent(flow, signal)) {
      await cancelGrantAndFail(
        flow,
        signal,
        deviceCode,
        "expired",
        "The session confirmation expired. Start again to get a new code.",
      );
    }
  };

  const pollUntilComplete = async (
    flow: number,
    controller: AbortController,
    deviceCode: string,
    details: DeviceGrantDetails,
  ): Promise<void> => {
    const { signal } = controller;
    let intervalSeconds = details.intervalSeconds;
    while (isCurrent(flow, signal) && Date.now() < details.expiresAt) {
      const nextDelayMs = Math.min(
        intervalSeconds * 1_000,
        Math.max(0, details.expiresAt - Date.now()),
      );
      if (nextDelayMs === 0) break;
      if (!(await waitForPoll(nextDelayMs, signal))) return;
      if (!isCurrent(flow, signal)) return;
      if (Date.now() >= details.expiresAt) break;
      const token = await apiAuth.pollDeviceSessionGrant(deviceCode, signal);
      if (!isCurrent(flow, signal)) return;
      if (token.data) {
        const intendedSessionExpiresIn = positiveSeconds(
          token.data.expires_in,
          12 * 60 * 60,
        );
        const confirmationExpiresIn = positiveSeconds(
          token.data.confirmation_expires_in,
          MAX_CONFIRM_SECONDS,
        );
        if (
          token.data.grant_kind !== "session" ||
          token.data.session !== true ||
          token.data.confirmation_required !== true ||
          token.data.remember !== false ||
          intendedSessionExpiresIn === null ||
          confirmationExpiresIn === null
        ) {
          // Poll success installs only a provisional cookie. Revoke that
          // exact grant capability rather than treating an unrelated /me
          // session as proof or issuing a broad logout.
          setState({ phase: "verifying", connectionIssue: false });
          await cancelGrantAndFail(
            flow,
            signal,
            deviceCode,
            "unavailable",
            "Moosewave returned an unexpected sign-in response. Start again.",
          );
          return;
        }
        setState({ phase: "verifying", connectionIssue: false });
        await confirmProvisionalSession(
          flow,
          controller,
          deviceCode,
          Date.now() + confirmationExpiresIn * 1_000,
        );
        return;
      }
      if (token.error.code === "aborted") return;
      const action = classifyDevicePollError(token.error.code);
      if (action === "pending") {
        setState({
          phase: "waiting",
          ...details,
          intervalSeconds,
          remainingSeconds: remainingSeconds(details.expiresAt),
        });
        continue;
      }
      if (action === "slow_down") {
        intervalSeconds = Math.min(MAX_POLL_SECONDS, intervalSeconds + 5);
        setState({
          phase: "waiting",
          ...details,
          intervalSeconds,
          remainingSeconds: remainingSeconds(details.expiresAt),
        });
        continue;
      }
      if (action === "denied") {
        fail(
          flow,
          signal,
          "denied",
          "The sign-in request was denied on the other device.",
        );
        return;
      }
      if (action === "expired") {
        fail(
          flow,
          signal,
          "expired",
          "This sign-in code expired. Start again to get a new code.",
        );
        return;
      }
      if (isRetryablePollTransport(token.error)) {
        setState({
          phase: "network",
          ...details,
          intervalSeconds,
          remainingSeconds: remainingSeconds(details.expiresAt),
        });
        continue;
      }
      fail(
        flow,
        signal,
        "unavailable",
        "Moosewave couldn't complete this device sign-in. Start again.",
      );
      return;
    }
    fail(
      flow,
      signal,
      "expired",
      "This sign-in code expired. Start again to get a new code.",
    );
  };

  const start = useCallback(async (): Promise<void> => {
    if (requestRef.current && !requestRef.current.signal.aborted) return;
    clearCountdown();
    deviceCodeRef.current = null;
    sessionIssuedRef.current = false;
    const flow = ++flowRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ phase: "starting" });
    const response = await apiAuth.startDeviceSessionGrant(controller.signal);
    if (!isCurrent(flow, controller.signal)) return;
    if (response.error) {
      if (response.error.code === "aborted") return;
      fail(
        flow,
        controller.signal,
        "unavailable",
        response.error.kind === "network" || response.error.kind === "timeout"
          ? "Moosewave couldn't connect. Check your connection and try again."
          : "Moosewave couldn't start device sign-in. Try again.",
      );
      return;
    }
    const grant = readDeviceGrant(response.data);
    if (!grant) {
      fail(
        flow,
        controller.signal,
        "unavailable",
        "Moosewave returned an incomplete sign-in response. Try again.",
      );
      return;
    }
    deviceCodeRef.current = grant.deviceCode;
    setState({
      phase: "waiting",
      ...grant.details,
      remainingSeconds: remainingSeconds(grant.details.expiresAt),
    });
    countdownRef.current = window.setInterval(() => {
      if (!isCurrent(flow, controller.signal)) return;
      const remaining = remainingSeconds(grant.details.expiresAt);
      setState((current) =>
        current.phase === "waiting" || current.phase === "network"
          ? { ...current, remainingSeconds: remaining }
          : current,
      );
    }, 1_000);
    void pollUntilComplete(flow, controller, grant.deviceCode, grant.details);
  }, []);

  const cancel = useCallback(async (): Promise<void> => {
    const shouldLogout = sessionIssuedRef.current;
    const pendingDeviceCode = deviceCodeRef.current;
    const flow = ++flowRef.current;
    requestRef.current?.abort();
    requestRef.current = null;
    clearCountdown();
    sessionIssuedRef.current = false;
    if (!shouldLogout && !pendingDeviceCode) {
      deviceCodeRef.current = null;
      if (mountedRef.current) setState({ phase: "idle" });
      return;
    }
    if (mountedRef.current) setState({ phase: "cancelling" });
    await Promise.allSettled([
      ...(pendingDeviceCode
        ? [apiAuth.cancelDeviceSessionGrant(pendingDeviceCode)]
        : []),
      ...(shouldLogout ? [apiAuth.logoutSession()] : []),
    ]);
    if (deviceCodeRef.current === pendingDeviceCode) {
      deviceCodeRef.current = null;
    }
    if (mountedRef.current && flowRef.current === flow) {
      setState({ phase: "idle" });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flowRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      clearCountdown();
      const pendingDeviceCode = deviceCodeRef.current;
      if (pendingDeviceCode) {
        void apiAuth.cancelDeviceSessionGrant(pendingDeviceCode);
      }
      deviceCodeRef.current = null;
      if (sessionIssuedRef.current) void apiAuth.logoutSession();
      sessionIssuedRef.current = false;
    };
  }, []);

  return { state, start, cancel };
}
