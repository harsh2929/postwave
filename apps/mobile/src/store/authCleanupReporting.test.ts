/**
 * What the secure-cleanup failure REPORTS, and who it is allowed to lock out.
 *
 * F04, reproduced on a simulator 2026-09-04: when launch-time cleanup failed,
 * the sign-in screen disabled BOTH "Sign in" and "Continue with Google"
 * (enabled=false in the accessibility tree) and every recovery a user would try
 * failed — the retry button, a relaunch (which is what the message literally
 * instructed), and deleting and reinstalling the app, because the marker is a
 * keychain item and iOS keeps those across app deletion. Only erasing the
 * device cleared it.
 *
 * The fail-closed latch is DELIBERATE and is not what these tests attack. What
 * they pin is the three things around it that were wrong:
 *
 *   1. The message named nothing. `cleanupWarning` was handed `failedAreas` and
 *      returned one fixed sentence, so neither the user nor any log ever
 *      learned which of the six areas failed.
 *   2. It fired with nothing to clean. On an erased device, fresh install,
 *      never signed in, the first launch still said "You are signed out, but
 *      secure local cleanup is incomplete" — false for that user, and it
 *      latched them out of an app they had not yet entered.
 *   3. The advice was wrong. "Restart the app ... to retry" describes what the
 *      code does (hydrate re-runs the wipe) but not what the user gets, and for
 *      a deterministic failure — an App Group that was never provisioned —
 *      restarting can never clear it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as SecureStore from "expo-secure-store";

import { createAuthClient } from "@/api/auth";
import { isProbablyOnline } from "@/lib/connectivity";
import { clearPendingAuthLinkStates } from "@/lib/magicLinkState";
import { queryPersister } from "@/lib/queryClient";
import { vaultClear, vaultRecoverPendingCleanup } from "@/lib/secureVault";
import { clearSharedInboxStrict } from "@/lib/sharedInbox";
import { clearWidgetSnapshotStrict } from "@/lib/widgetData";

import {
  sessionProfileFromMe,
  useAuthStore,
  type SessionProfile,
} from "./auth";

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("@/api/sdkClient", () => ({ clearClient: vi.fn() }));
vi.mock("@/api/auth", () => ({
  createAuthClient: vi.fn(),
  setMfaRequiredObserver: vi.fn(),
}));
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: vi.fn(() => true) }));
vi.mock("@/lib/magicLinkState", () => ({ clearPendingAuthLinkStates: vi.fn() }));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { clear: vi.fn() },
  queryPersister: { removeClient: vi.fn() },
}));
vi.mock("@/lib/secureVault", () => ({
  vaultClear: vi.fn(),
  vaultRecoverPendingCleanup: vi.fn(),
}));
vi.mock("@/lib/sharedInbox", () => ({
  clearSharedInbox: vi.fn(),
  clearSharedInboxStrict: vi.fn(),
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn(), reset: vi.fn() }));
vi.mock("@/lib/widgetData", () => ({
  clearWidgetSnapshot: vi.fn(),
  clearWidgetSnapshotStrict: vi.fn(),
}));

const CLEANUP_MARKER = "postwave.auth_cleanup_pending";

/**
 * The failure that produced F04: a simulator build signed with no development
 * team has an empty entitlements dict, so `group.com.moosewave.app` does not
 * exist and the App Group clears can only ever fail — on every launch, for
 * every user, whether or not they have ever signed in.
 */
function appGroupNeverProvisioned(): void {
  vi.mocked(clearSharedInboxStrict).mockRejectedValue(
    new Error("Share inbox App Group cleanup is incomplete"),
  );
  vi.mocked(clearWidgetSnapshotStrict).mockRejectedValue(
    new Error("Widget App Group cleanup is incomplete"),
  );
}

function profile(): SessionProfile {
  return sessionProfileFromMe({
    email: "owner@example.com",
    user_id: "user_1",
    tenant_id: "tenant_1",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    can_use_viewer_mode: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
    totp_enabled: false,
    mfa_required: false,
    mfa_satisfied: false,
  });
}

function setSessionState(): void {
  useAuthStore.setState({
    apiKey: null,
    baseUrl: "https://api.moosewave.com",
    tenantId: "tenant_1",
    mode: "session",
    session: profile(),
    sessionValidation: "validated_online",
    hydrated: true,
    signingIn: false,
    authWarning: null,
    localCleanupPending: false,
  });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  vi.mocked(SecureStore.setItemAsync).mockResolvedValue();
  vi.mocked(SecureStore.deleteItemAsync).mockResolvedValue();
  vi.mocked(vaultClear).mockResolvedValue();
  vi.mocked(vaultRecoverPendingCleanup).mockResolvedValue(false);
  vi.mocked(queryPersister.removeClient).mockResolvedValue();
  vi.mocked(clearPendingAuthLinkStates).mockResolvedValue();
  vi.mocked(clearSharedInboxStrict).mockResolvedValue();
  vi.mocked(clearWidgetSnapshotStrict).mockResolvedValue();
  vi.mocked(isProbablyOnline).mockReturnValue(true);
  vi.mocked(createAuthClient).mockImplementation(
    (baseUrl) =>
      ({
        baseUrl,
        getMe: vi.fn(),
        logoutSession: vi.fn(async () => ({ data: undefined })),
      }) as unknown as ReturnType<typeof createAuthClient>,
  );
  useAuthStore.setState({
    apiKey: null,
    baseUrl: null,
    tenantId: null,
    mode: null,
    session: null,
    sessionValidation: "none",
    hydrated: false,
    signingIn: false,
    authWarning: null,
    localCleanupPending: false,
  });
});

function warnedText(): string {
  return warn.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("a wipe with nothing to wipe", () => {
  it("does not latch the sign-in screen shut on a first launch", async () => {
    // Erased device, fresh install, never signed in: the keychain is empty.
    // The vault cleanup-journal probe is the first Keychain call the process
    // makes and the flakiest one there is (first call after a device unlock),
    // and when it throws, hydrate wipes before it has read anything.
    appGroupNeverProvisioned();
    vi.mocked(vaultRecoverPendingCleanup).mockRejectedValue(
      new Error("keychain busy"),
    );

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    // THE LATCH. `localCleanupPending` is what disables BOTH "Sign in" and
    // "Continue with Google" (lib/signInForm.ts). A user who was never signed
    // in has nothing to be signed out of and must not meet it.
    expect(state.localCleanupPending).toBe(false);
    // ...and is not told a sentence that is false for them.
    expect(state.authWarning).toBeNull();
    expect(state.hydrated).toBe(true);
    expect(state.mode).toBeNull();
  });

  it("leaves behind no marker for the next launch to find", async () => {
    // The reason a relaunch and even a REINSTALL could not clear this: the
    // marker is a keychain item, and iOS keeps keychain items across app
    // deletion. If the no-op wipe writes it and does not take it back, the
    // device is latched from then on and only a full erase gets it back.
    appGroupNeverProvisioned();
    vi.mocked(vaultRecoverPendingCleanup).mockRejectedValue(
      new Error("keychain busy"),
    );

    await useAuthStore.getState().hydrate();

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
      CLEANUP_MARKER,
      expect.any(Object),
    );
  });

  it("still tells an operator which area failed", async () => {
    // Silent for the USER, never silent in the log. An App Group that was
    // never provisioned is a real build problem; it is just not this user's
    // problem, and it took a simulator session to identify precisely because
    // nothing named it anywhere.
    appGroupNeverProvisioned();
    vi.mocked(vaultRecoverPendingCleanup).mockRejectedValue(
      new Error("keychain busy"),
    );

    await useAuthStore.getState().hydrate();

    expect(warnedText()).toContain("shared_inbox");
    expect(warnedText()).toContain("widget_snapshot");
  });
});

describe("a wipe that really had something to remove", () => {
  it("still latches when a live session's artifacts could not go", async () => {
    // The case the silence above must not weaken: a session WAS present, its
    // artifacts must go, and one of them did not.
    setSessionState();
    appGroupNeverProvisioned();

    const result = await useAuthStore.getState().cancelSession();

    expect(result.cleanup.complete).toBe(false);
    expect(result.cleanup.failedAreas).toContain("shared_inbox");
    expect(useAuthStore.getState().localCleanupPending).toBe(true);
  });

  it("still latches when the device cannot say what it holds", async () => {
    // The probe buys silence by PROVING the device is empty. A keychain that
    // will not answer proves nothing, and the wrong way to read that is as an
    // empty device: the exact moment the keychain is broken is the moment a
    // previous account's artifacts are most likely to be sitting there.
    appGroupNeverProvisioned();
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(
      new Error("keychain unavailable"),
    );

    const result = await useAuthStore.getState().retryLocalCleanup();

    expect(result.complete).toBe(false);
    expect(result.failedAreas).toContain("shared_inbox");
    expect(useAuthStore.getState().localCleanupPending).toBe(true);
  });

  it("still latches when the device's own marker proves a wipe never finished", async () => {
    // The other half of the invariant, and the one that does not depend on
    // anything held in memory: the marker survived, so the last wipe did not
    // finish, so those containers were never verified empty.
    appGroupNeverProvisioned();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === CLEANUP_MARKER ? "1" : null,
    );

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().localCleanupPending).toBe(true);
    expect(useAuthStore.getState().authWarning).toMatch(/shared_inbox/);
  });
});

describe("the sentence the user is shown", () => {
  async function warningAfterFailedSignOut(): Promise<string> {
    setSessionState();
    await useAuthStore.getState().cancelSession();
    const warning = useAuthStore.getState().authWarning;
    expect(warning, "expected a warning to assert against").not.toBeNull();
    return warning as string;
  }

  it("names the areas that failed", async () => {
    appGroupNeverProvisioned();

    const warning = await warningAfterFailedSignOut();

    expect(warning).toContain("shared_inbox");
    expect(warning).toContain("widget_snapshot");
  });

  it("names areas, never the values held in them", async () => {
    // `secure_store:postwave.api_key` is a symptom an operator can act on.
    // The key's VALUE is a credential and must never reach a banner or a log.
    setSessionState();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "postwave.api_key" ? "pw_live_do_not_print_me" : null,
    );
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.api_key") throw new Error("keychain locked");
    });

    const result = await useAuthStore.getState().cancelSession();
    const warning = useAuthStore.getState().authWarning ?? "";

    expect(result.cleanup.failedAreas).toContain("secure_store:postwave.api_key");
    expect(warning).toContain("secure_store:api_key");
    expect(warning).not.toContain("pw_live_do_not_print_me");
    expect(warnedText()).not.toContain("pw_live_do_not_print_me");
  });

  it("stays a sentence rather than a list when everything fails", async () => {
    // Six SecureStore keys can fail at once. A banner is four lines of 12pt
    // text on a phone; it summarises rather than paging out the whole set,
    // and the full list is in the log.
    setSessionState();
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(
      new Error("keychain locked"),
    );

    const result = await useAuthStore.getState().cancelSession();
    const warning = useAuthStore.getState().authWarning ?? "";

    expect(result.cleanup.failedAreas.length).toBeGreaterThan(4);
    expect(warning).toMatch(/and \d+ more/);
    // Truncated, but never to nothing: the first areas are still named.
    expect(warning).toContain("secure_store:api_key");
  });

  it("gives advice that is true, and points at a control that exists", async () => {
    appGroupNeverProvisioned();

    const warning = await warningAfterFailedSignOut();

    // The advice that was wrong. Restarting DOES re-run the wipe, but it was
    // read as a promise that restarting would clear it, and for a
    // deterministic failure it never can.
    expect(warning).not.toContain(
      "Restart the app while the device is unlocked to retry",
    );
    expect(warning).toContain(
      "restarting or reinstalling the app will not clear this on its own",
    );

    // And the one thing it does tell the user to do must be a control that is
    // really on the screen. Asserted against SOURCE because the component
    // pulls react-native, which does not load in this environment.
    const retryLabel = "Retry secure cleanup";
    expect(warning).toContain(retryLabel);
    const view = readFileSync(
      resolve(__dirname, "../components/auth/AuthWarning.tsx"),
      "utf8",
    );
    expect(
      view.includes(retryLabel),
      "the warning tells the user to tap a control AuthWarning does not render",
    ).toBe(true);
  });
});
