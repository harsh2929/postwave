import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelDeviceSessionGrant,
  startDeviceSessionGrant,
} from "@/api/deviceSessionSignIn";
import type { SessionProfile } from "@/store/auth";
import { useAuthStore } from "@/store/auth";

import {
  runDeviceSessionGrantLifecycle,
  waitForPendingDeviceSessionPersistence,
  type MobileDeviceSignInState,
} from "./deviceSessionSignInLifecycle";

export type { MobileDeviceSignInState } from "./deviceSessionSignInLifecycle";

function remainingSeconds(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

/**
 * Owns the target-device lifecycle. The device_code stays exclusively in a
 * ref and local async arguments, never in React state or navigation params.
 */
export function useDeviceSessionSignIn({
  baseUrl,
  remember,
  onSignedIn,
}: {
  baseUrl: string;
  remember: boolean;
  onSignedIn: (profile: SessionProfile) => void;
}): {
  state: MobileDeviceSignInState;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
} {
  const [state, setState] = useState<MobileDeviceSignInState>({
    phase: "idle",
  });
  const mountedRef = useRef(false);
  const flowRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const deviceCodeRef = useRef<string | null>(null);
  const grantBaseUrlRef = useRef<string | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const persistenceRef = useRef<Promise<void> | null>(null);
  const sessionIssuedRef = useRef(false);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  const clearCountdown = useCallback((): void => {
    if (countdownRef.current !== null) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const isCurrent = useCallback(
    (flow: number, signal: AbortSignal): boolean =>
      mountedRef.current && flowRef.current === flow && !signal.aborted,
    [],
  );

  const clearRuntime = useCallback((): void => {
    clearCountdown();
    controllerRef.current = null;
    deviceCodeRef.current = null;
    grantBaseUrlRef.current = null;
  }, [clearCountdown]);

  const fail = useCallback(
    (
      flow: number,
      signal: AbortSignal,
      reason: "denied" | "expired" | "unavailable",
      message: string,
    ): void => {
      if (!isCurrent(flow, signal)) return;
      clearRuntime();
      setState({ phase: "error", reason, message });
    },
    [clearRuntime, isCurrent],
  );

  const start = useCallback(async (): Promise<void> => {
    const previousCode = deviceCodeRef.current;
    const previousBaseUrl = grantBaseUrlRef.current;
    controllerRef.current?.abort();
    clearCountdown();
    if (previousCode && previousBaseUrl) {
      void cancelDeviceSessionGrant(previousBaseUrl, previousCode);
    }
    const flow = ++flowRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    deviceCodeRef.current = null;
    grantBaseUrlRef.current = baseUrl;
    sessionIssuedRef.current = false;
    setState({ phase: "starting" });
    try {
      await waitForPendingDeviceSessionPersistence();
      if (!isCurrent(flow, controller.signal)) return;
      await useAuthStore.getState().prepareForSessionAuthentication();
    } catch (error) {
      fail(
        flow,
        controller.signal,
        "unavailable",
        error instanceof Error
          ? error.message
          : "This device is not ready to sign in.",
      );
      return;
    }
    if (!isCurrent(flow, controller.signal)) return;
    const result = await startDeviceSessionGrant(
      baseUrl,
      remember,
      controller.signal,
    );
    if (!isCurrent(flow, controller.signal)) return;
    if (result.error) {
      fail(
        flow,
        controller.signal,
        "unavailable",
        result.error.kind === "network" || result.error.kind === "timeout"
          ? "Moosewave could not connect. Check your connection and try again."
          : result.error.message,
      );
      return;
    }
    const grant = result.data;
    const expiresAt = Date.now() + grant.expiresIn * 1000;
    deviceCodeRef.current = grant.deviceCode;
    setState({
      phase: "waiting",
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
      verificationUriComplete: grant.verificationUriComplete,
      expiresAt,
      interval: grant.interval,
      remainingSeconds: remainingSeconds(expiresAt),
      remember: grant.remember,
    });
    countdownRef.current = setInterval(() => {
      if (!isCurrent(flow, controller.signal)) return;
      setState((current) =>
        current.phase === "waiting" || current.phase === "network"
          ? {
              ...current,
              remainingSeconds: remainingSeconds(current.expiresAt),
            }
          : current,
      );
    }, 1000);
    void runDeviceSessionGrantLifecycle({
      controller,
      grantBaseUrl: baseUrl,
      deviceCode: grant.deviceCode,
      grant,
      callbacks: {
        isCurrent: () => isCurrent(flow, controller.signal),
        setState,
        fail: (reason, message) =>
          fail(flow, controller.signal, reason, message),
        clearCountdown,
        setSessionIssued: (issued) => {
          sessionIssuedRef.current = issued;
        },
        trackPersistence: (persistence) => {
          persistenceRef.current = persistence;
        },
        clearPersistence: (persistence) => {
          if (persistenceRef.current === persistence) {
            persistenceRef.current = null;
          }
        },
        complete: (profile) => {
          if (!isCurrent(flow, controller.signal)) return;
          clearRuntime();
          setState({ phase: "idle" });
          onSignedInRef.current(profile);
        },
      },
    });
  }, [baseUrl, clearCountdown, clearRuntime, fail, isCurrent, remember]);

  const cancel = useCallback(async (): Promise<void> => {
    const code = deviceCodeRef.current;
    const grantBaseUrl = grantBaseUrlRef.current;
    const issued = sessionIssuedRef.current;
    const pendingPersistence = persistenceRef.current;
    const flow = ++flowRef.current;
    controllerRef.current?.abort();
    clearRuntime();
    sessionIssuedRef.current = false;
    if (mountedRef.current) setState({ phase: "cancelling" });
    if (code && grantBaseUrl) {
      await cancelDeviceSessionGrant(grantBaseUrl, code);
    } else if (issued && grantBaseUrl) {
      await useAuthStore.getState().cancelSession(grantBaseUrl);
    }
    if (pendingPersistence) {
      await pendingPersistence.catch(() => undefined);
    }
    if (mountedRef.current && flowRef.current === flow) {
      setState({ phase: "idle" });
    }
  }, [clearRuntime]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flowRef.current += 1;
      controllerRef.current?.abort();
      const code = deviceCodeRef.current;
      const grantBaseUrl = grantBaseUrlRef.current;
      const issued = sessionIssuedRef.current;
      clearRuntime();
      sessionIssuedRef.current = false;
      if (code && grantBaseUrl) {
        void cancelDeviceSessionGrant(grantBaseUrl, code);
      } else if (issued && grantBaseUrl) {
        void useAuthStore.getState().cancelSession(grantBaseUrl);
      }
    };
  }, [clearRuntime]);

  return { state, start, cancel };
}
