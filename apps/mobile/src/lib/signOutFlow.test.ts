import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirmAndSignOut,
  isSigningOut,
  resetSignOutGuard,
  runSignOut,
  signOutCopy,
  type SignOutFlowDeps,
} from "./signOutFlow";

function deps(over: Partial<SignOutFlowDeps> = {}): SignOutFlowDeps {
  return {
    mode: "session",
    confirm: vi.fn(async () => true),
    performSignOut: vi.fn(async () => undefined),
    navigateToSignIn: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  resetSignOutGuard();
});

describe("signOutCopy", () => {
  it("tells a session user the server session is revoked too", () => {
    expect(signOutCopy("session").message).toMatch(/revoked on the server/iu);
  });

  it("tells an api-key user only the local key goes", () => {
    const copy = signOutCopy("api_key");
    expect(copy.message).toMatch(/API key/iu);
    expect(copy.message).not.toMatch(/server/iu);
  });

  it("always uses a verb for the affirmative button", () => {
    expect(signOutCopy(null).confirmLabel).toBe("Sign out");
    expect(signOutCopy(null).destructive).toBe(true);
  });
});

describe("confirmAndSignOut", () => {
  it("does nothing when the user cancels", async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    expect(await confirmAndSignOut(d)).toBe("cancelled");
    expect(d.performSignOut).not.toHaveBeenCalled();
    expect(d.navigateToSignIn).not.toHaveBeenCalled();
  });

  it("tears down then navigates", async () => {
    const order: string[] = [];
    const d = deps({
      performSignOut: vi.fn(async () => {
        order.push("teardown");
      }),
      navigateToSignIn: vi.fn(() => order.push("navigate")),
    });
    expect(await confirmAndSignOut(d)).toBe("signed-out");
    expect(order).toEqual(["teardown", "navigate"]);
  });

  it("still navigates when revocation fails, so the user is never stranded on an authed screen", async () => {
    const d = deps({
      performSignOut: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    // Resolves rather than rejecting: every call site is a fire-and-forget
    // onPress, so a rejection here would be an unobserved promise rejection
    // for a case the flow has already recovered from.
    expect(await confirmAndSignOut(d)).toBe("signed-out-degraded");
    expect(d.navigateToSignIn).toHaveBeenCalledTimes(1);
    expect(isSigningOut()).toBe(false);
  });

  it("frees the guard after a failed teardown so a retry is possible", async () => {
    await confirmAndSignOut(
      deps({
        performSignOut: vi.fn(async () => {
          throw new Error("network down");
        }),
      }),
    );
    expect(await confirmAndSignOut(deps())).toBe("signed-out");
  });

  it("refuses a second concurrent teardown — the race the two old copies allowed", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const performSignOut = vi.fn(async () => gate);
    const first = confirmAndSignOut(deps({ performSignOut }));
    // Yield so the first flow passes its confirm() await and takes the guard.
    await Promise.resolve();
    await Promise.resolve();
    expect(await confirmAndSignOut(deps({ performSignOut }))).toBe(
      "already-running",
    );
    release();
    await first;
    expect(performSignOut).toHaveBeenCalledTimes(1);
  });

  it("leaves the action available after a cancel", async () => {
    await confirmAndSignOut(deps({ confirm: vi.fn(async () => false) }));
    expect(isSigningOut()).toBe(false);
    expect(await confirmAndSignOut(deps())).toBe("signed-out");
  });

  it("reports busy transitions for the caller's label", async () => {
    const seen: boolean[] = [];
    await confirmAndSignOut(deps({ onBusyChange: (b) => seen.push(b) }));
    expect(seen).toEqual([true, false]);
  });
});

describe("runSignOut (already-confirmed call sites)", () => {
  it("tears down, navigates and reports busy without asking again", async () => {
    const seen: boolean[] = [];
    const performSignOut = vi.fn(async () => undefined);
    const navigateToSignIn = vi.fn();
    const confirm = vi.fn(async () => true);

    const outcome = await runSignOut({
      performSignOut,
      navigateToSignIn,
      onBusyChange: (b) => seen.push(b),
    });

    expect(outcome).toBe("signed-out");
    expect(confirm).not.toHaveBeenCalled();
    expect(performSignOut).toHaveBeenCalledTimes(1);
    expect(navigateToSignIn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([true, false]);
  });

  it("shares the guard with confirmAndSignOut, so the two paths cannot race", async () => {
    let release = () => {};
    const performSignOut = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const first = runSignOut({ performSignOut, navigateToSignIn: vi.fn() });
    expect(isSigningOut()).toBe(true);

    // The deletion card is mid-teardown; a Settings tap must be refused.
    expect(await confirmAndSignOut(deps())).toBe("already-running");

    release();
    await first;
    expect(performSignOut).toHaveBeenCalledTimes(1);
    expect(isSigningOut()).toBe(false);
  });

  it("still navigates and reports degradation when revocation throws", async () => {
    const navigateToSignIn = vi.fn();
    const outcome = await runSignOut({
      performSignOut: vi.fn(async () => {
        throw new Error("push revoke failed");
      }),
      navigateToSignIn,
    });
    expect(outcome).toBe("signed-out-degraded");
    expect(navigateToSignIn).toHaveBeenCalledTimes(1);
    expect(isSigningOut()).toBe(false);
  });
});
