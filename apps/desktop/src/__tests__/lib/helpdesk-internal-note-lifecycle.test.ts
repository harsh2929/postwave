// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inspectInternalNoteRecoveryInventory } from "../../components/helpdesk/internal-note-recovery";
import { registerInternalNoteRecoverySignOutGuard } from "../../lib/helpdesk-internal-note-lifecycle";
import {
  cancelLifecycleTransition,
  getLifecycleDecisionState,
  inspectLifecycle,
  requestLifecycleTransition,
  resetLifecycleCoordinatorForTests,
} from "../../lib/lifecycle-coordinator";

const SIGN_OUT_INTENT = {
  kind: "sign-out" as const,
  disposition: "identity-change" as const,
  title: "Sign out?",
  description: "Review local work.",
  confirmLabel: "Sign out",
};
const V3_VAULT_KEY =
  "postwave.desktop.vault.v1:helpdesk-internal-note-intents.v3.v3-session-aaaaaaaaaaaaaaaa";

beforeEach(() => {
  window.localStorage.clear();
  resetLifecycleCoordinatorForTests();
});

afterEach(() => {
  resetLifecycleCoordinatorForTests();
  vi.restoreAllMocks();
});

describe("Helpdesk internal-note sign-out lifecycle", () => {
  it("blocks a privacy purge while any prepared or unknown checkpoint exists", async () => {
    window.localStorage.setItem(V3_VAULT_KEY, "encrypted-checkpoint");
    const unregister = registerInternalNoteRecoverySignOutGuard();
    const proceed = vi.fn();

    const result = requestLifecycleTransition(SIGN_OUT_INTENT, proceed);
    await vi.waitFor(() =>
      expect(getLifecycleDecisionState().phase).toBe("review"),
    );
    const [concern] = getLifecycleDecisionState().concerns;
    expect(concern).toMatchObject({
      level: "blocking",
      canDiscard: false,
      canRecover: false,
      canSave: false,
    });
    expect(concern?.detail).toContain("original signed-in workspace");
    expect(proceed).not.toHaveBeenCalled();

    cancelLifecycleTransition();
    await expect(result).resolves.toBe("cancelled");
    expect(proceed).not.toHaveBeenCalled();
    unregister();
  });

  it("allows sign-out after the final checkpoint is settled", async () => {
    window.localStorage.setItem(V3_VAULT_KEY, "encrypted-checkpoint");
    const unregister = registerInternalNoteRecoverySignOutGuard();
    expect(await inspectLifecycle(SIGN_OUT_INTENT)).toHaveLength(1);

    window.localStorage.removeItem(V3_VAULT_KEY);
    const proceed = vi.fn();
    await expect(
      requestLifecycleTransition(SIGN_OUT_INTENT, proceed),
    ).resolves.toBe("proceeded");
    expect(proceed).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("holds originless v2 quarantine state without exposing record content", async () => {
    window.localStorage.setItem(
      "postwave.helpdesk-note-quarantine.v2:v2-session-private",
      "1",
    );
    const unregister = registerInternalNoteRecoverySignOutGuard();
    const concerns = await inspectLifecycle(SIGN_OUT_INTENT);

    expect(concerns).toHaveLength(1);
    expect(JSON.stringify(concerns)).not.toContain("v2-session-private");
    expect(concerns[0]?.level).toBe("blocking");
    unregister();
  });

  it("fails closed when checkpoint storage inventory cannot be verified", () => {
    window.localStorage.setItem("force-enumeration", "1");
    vi.spyOn(window.localStorage, "key").mockImplementation(() => {
      throw new Error("storage denied");
    });

    expect(inspectInternalNoteRecoveryInventory()).toBe("unavailable");
  });
});
