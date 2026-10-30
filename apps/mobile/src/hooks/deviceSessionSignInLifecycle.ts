import { createAuthClient } from "@/api/auth";
import {
  cancelDeviceSessionGrant,
  confirmDeviceSessionGrant,
  decideDeviceSessionPoll,
  pollDeviceSessionGrant,
  type DeviceSessionGrantStart,
} from "@/api/deviceSessionSignIn";
import type { SessionProfile } from "@/store/auth";
import { sessionProfileFromMe, useAuthStore } from "@/store/auth";

interface GrantView {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  interval: number;
  remainingSeconds: number;
  remember: boolean;
}

export type MobileDeviceSignInState =
  | { phase: "idle" }
  | { phase: "starting" | "cancelling" }
  | ({ phase: "waiting" } & GrantView)
  | ({ phase: "network" } & GrantView)
  | { phase: "verifying"; connectionIssue: boolean }
  | {
      phase: "error";
      reason: "denied" | "expired" | "unavailable";
      message: string;
    };

type FailureReason = Extract<
  MobileDeviceSignInState,
  { phase: "error" }
>["reason"];

interface LifecycleCallbacks {
  isCurrent: () => boolean;
  setState: (state: MobileDeviceSignInState) => void;
  fail: (reason: FailureReason, message: string) => void;
  clearCountdown: () => void;
  setSessionIssued: (issued: boolean) => void;
  trackPersistence: (persistence: Promise<void>) => void;
  clearPersistence: (persistence: Promise<void>) => void;
  complete: (profile: SessionProfile) => void;
}

interface LifecycleInput {
  controller: AbortController;
  grantBaseUrl: string;
  deviceCode: string;
  grant: DeviceSessionGrantStart;
  callbacks: LifecycleCallbacks;
}

const MAX_NETWORK_DELAY_SECONDS = 30;
const CONFIRM_RETRY_SECONDS = 5;
const SESSION_VERIFY_SECONDS = 60;

// Native cookie storage is shared across mounted auth routes. A new device
// flow must not replace that cookie while an older flow is still committing
// secure local state and may need to clear it after cancellation.
const pendingDeviceSessionPersistence = new Set<Promise<void>>();

export async function waitForPendingDeviceSessionPersistence(): Promise<void> {
  await Promise.allSettled(Array.from(pendingDeviceSessionPersistence));
}

function remainingSeconds(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function waitFor(seconds: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (elapsed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), seconds * 1000);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function networkDelay(interval: number, failures: number): number {
  return Math.min(
    MAX_NETWORK_DELAY_SECONDS,
    Math.max(interval, interval * 2 ** Math.min(3, failures)),
  );
}

function grantState(
  phase: "waiting" | "network",
  grant: DeviceSessionGrantStart,
  expiresAt: number,
  interval: number,
): MobileDeviceSignInState {
  return {
    phase,
    userCode: grant.userCode,
    verificationUri: grant.verificationUri,
    verificationUriComplete: grant.verificationUriComplete,
    expiresAt,
    interval,
    remainingSeconds: remainingSeconds(expiresAt),
    remember: grant.remember,
  };
}

async function persistVerifiedProfile(
  input: LifecycleInput,
  profile: SessionProfile,
): Promise<void> {
  const { callbacks, deviceCode, grantBaseUrl } = input;
  // signInSession owns server revocation if its secure local transaction
  // fails, so stale cleanup must not race a new shared-cookie flow.
  callbacks.setSessionIssued(false);
  try {
    await useAuthStore.getState().signInSession({
      baseUrl: grantBaseUrl,
      profile,
    });
  } catch (error) {
    await cancelDeviceSessionGrant(grantBaseUrl, deviceCode);
    if (!callbacks.isCurrent()) {
      await useAuthStore
        .getState()
        .cancelSession(grantBaseUrl)
        .catch(() => undefined);
      return;
    }
    callbacks.fail(
      "unavailable",
      error instanceof Error
        ? error.message
        : "Approval succeeded, but this device could not save the session.",
    );
    return;
  }
  if (!callbacks.isCurrent()) {
    await useAuthStore
      .getState()
      .cancelSession(grantBaseUrl)
      .catch(() => undefined);
    return;
  }
  callbacks.complete(profile);
}

async function verifySession(
  input: LifecycleInput,
  expiresAt: number,
): Promise<void> {
  const { callbacks, controller, deviceCode, grantBaseUrl } = input;
  const { signal } = controller;
  while (callbacks.isCurrent() && Date.now() < expiresAt) {
    const me = await createAuthClient(grantBaseUrl).getMe();
    if (!callbacks.isCurrent()) return;
    if (me.data) {
      const profile = sessionProfileFromMe(me.data);
      const persistence = persistVerifiedProfile(input, profile);
      callbacks.trackPersistence(persistence);
      pendingDeviceSessionPersistence.add(persistence);
      try {
        await persistence;
      } finally {
        pendingDeviceSessionPersistence.delete(persistence);
        callbacks.clearPersistence(persistence);
      }
      return;
    }
    if (me.error.kind === "network" || me.error.kind === "timeout") {
      callbacks.setState({ phase: "verifying", connectionIssue: true });
      if (!(await waitFor(CONFIRM_RETRY_SECONDS, signal))) return;
      continue;
    }
    await cancelDeviceSessionGrant(grantBaseUrl, deviceCode);
    callbacks.setSessionIssued(false);
    callbacks.fail(
      "unavailable",
      "Approval succeeded, but Moosewave could not verify the new session. Start again.",
    );
    return;
  }
  if (!callbacks.isCurrent()) return;
  await cancelDeviceSessionGrant(grantBaseUrl, deviceCode);
  callbacks.setSessionIssued(false);
  callbacks.fail(
    "expired",
    "The approval completed, but the new session could not be verified in time.",
  );
}

async function cancelAndFail(
  input: LifecycleInput,
  reason: FailureReason,
  message: string,
): Promise<void> {
  await cancelDeviceSessionGrant(input.grantBaseUrl, input.deviceCode);
  input.callbacks.setSessionIssued(false);
  input.callbacks.fail(reason, message);
}

/** Runs polling, provisional-cookie confirmation, and local persistence. */
export async function runDeviceSessionGrantLifecycle(
  input: LifecycleInput,
): Promise<void> {
  const { callbacks, controller, deviceCode, grant, grantBaseUrl } = input;
  const { signal } = controller;
  let expiresAt = Date.now() + grant.expiresIn * 1000;
  let interval = grant.interval;
  let delay = interval;
  let networkFailures = 0;
  let confirmationRequired = false;
  while (callbacks.isCurrent() && Date.now() < expiresAt) {
    if (delay > 0) {
      const boundedDelay = Math.min(
        delay,
        Math.max(0, (expiresAt - Date.now()) / 1000),
      );
      if (boundedDelay === 0) break;
      if (!(await waitFor(boundedDelay, signal))) return;
    }
    if (!callbacks.isCurrent() || Date.now() >= expiresAt) break;
    const result = confirmationRequired
      ? await confirmDeviceSessionGrant(
          grantBaseUrl,
          deviceCode,
          grant.remember,
          signal,
        )
      : await pollDeviceSessionGrant(
          grantBaseUrl,
          deviceCode,
          grant.remember,
          signal,
        );
    if (!callbacks.isCurrent()) return;
    if (result.data) {
      if (!confirmationRequired) {
        if (!("confirmation_expires_in" in result.data)) {
          await cancelAndFail(
            input,
            "unavailable",
            "Moosewave did not return a session confirmation lease.",
          );
          return;
        }
        confirmationRequired = true;
        callbacks.setSessionIssued(true);
        expiresAt = Date.now() + result.data.confirmation_expires_in * 1000;
        delay = 0;
        callbacks.clearCountdown();
        callbacks.setState({ phase: "verifying", connectionIssue: false });
        continue;
      }
      callbacks.setSessionIssued(true);
      callbacks.clearCountdown();
      callbacks.setState({ phase: "verifying", connectionIssue: false });
      await verifySession(input, Date.now() + SESSION_VERIFY_SECONDS * 1000);
      return;
    }
    const decision = decideDeviceSessionPoll(result.error);
    if (decision.kind === "pending" || decision.kind === "slow_down") {
      if (confirmationRequired) {
        await cancelAndFail(
          input,
          "unavailable",
          "Moosewave returned an unexpected session confirmation response. Start again.",
        );
        return;
      }
      networkFailures = 0;
      if (decision.kind === "slow_down") interval = Math.min(60, interval + 5);
      delay = interval;
      callbacks.setState(grantState("waiting", grant, expiresAt, interval));
      continue;
    }
    if (decision.kind === "network") {
      networkFailures += 1;
      delay = confirmationRequired
        ? CONFIRM_RETRY_SECONDS
        : networkDelay(interval, networkFailures);
      callbacks.setState(
        confirmationRequired
          ? { phase: "verifying", connectionIssue: true }
          : grantState("network", grant, expiresAt, interval),
      );
      continue;
    }
    if (decision.kind === "denied") {
      await cancelAndFail(
        input,
        "denied",
        "The other device denied this sign-in.",
      );
      return;
    }
    if (decision.kind === "expired") {
      await cancelAndFail(
        input,
        "expired",
        "This sign-in code expired. Start again.",
      );
      return;
    }
    // A syntactically malformed 200 can still have committed the provisional
    // Set-Cookie. Revoke by the exact memory-held capability before dropping
    // it; never treat an unrelated /me session as proof.
    await cancelAndFail(input, "unavailable", decision.message);
    return;
  }
  await cancelAndFail(
    input,
    "expired",
    "This sign-in code expired. Start again.",
  );
}
