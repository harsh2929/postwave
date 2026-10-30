// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  continueLifecycleTransition,
  discardAndRecheckLifecycleTransition,
  getLifecycleDecisionState,
  inspectLifecycle,
  registerLifecycleGuard,
  requestLifecycleTransition,
  resetLifecycleCoordinatorForTests,
  retryLifecycleTransition,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  title: "Quit Moosewave?",
  description: "Check active work before quitting.",
  confirmLabel: "Quit Moosewave",
};

afterEach(() => {
  vi.useRealTimers();
  resetLifecycleCoordinatorForTests();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("lifecycle coordinator", () => {
  it("prepares and proceeds immediately when registered work is safe", async () => {
    const prepare = vi.fn();
    const proceed = vi.fn();
    registerLifecycleGuard({
      id: "safe-draft",
      label: "Saved draft",
      inspect: () => null,
      prepare,
    });

    await expect(requestLifecycleTransition(quitIntent, proceed)).resolves.toBe(
      "proceeded",
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(getLifecycleDecisionState().phase).toBe("idle");
  });

  it("requires review for warnings, saves, revalidates, and then proceeds", async () => {
    let dirty = true;
    const proceed = vi.fn();
    registerLifecycleGuard({
      id: "campaign-draft",
      label: "Campaign draft",
      inspect: () =>
        dirty
          ? { level: "warning", detail: "One unsaved subject line." }
          : null,
      prepare: () => {
        dirty = false;
      },
    });

    const result = requestLifecycleTransition(quitIntent, proceed);
    await settle();
    expect(getLifecycleDecisionState()).toMatchObject({
      phase: "review",
      concerns: [
        {
          guardId: "campaign-draft",
          level: "warning",
          canSave: true,
        },
      ],
    });

    continueLifecycleTransition();
    await expect(result).resolves.toBe("proceeded");
    expect(dirty).toBe(false);
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("blocks continuation until an explicit discard resolves the concern", async () => {
    let localJournal = true;
    const proceed = vi.fn();
    registerLifecycleGuard({
      id: "outbox",
      label: "Changes waiting to sync",
      inspect: () =>
        localJournal
          ? { level: "blocking", detail: "One local change remains." }
          : null,
      discard: () => {
        localJournal = false;
      },
    });

    const result = requestLifecycleTransition(quitIntent, proceed);
    await settle();
    continueLifecycleTransition();
    await settle();
    expect(proceed).not.toHaveBeenCalled();

    await discardAndRecheckLifecycleTransition();
    await expect(result).resolves.toBe("proceeded");
    expect(localJournal).toBe(false);
  });

  it("fails closed when inspection throws", async () => {
    registerLifecycleGuard({
      id: "unknown-upload",
      label: "Subscriber upload",
      inspect: () => {
        throw new Error("private failure");
      },
    });

    const result = requestLifecycleTransition(quitIntent, vi.fn());
    await settle();
    const concern = getLifecycleDecisionState().concerns[0];
    expect(concern).toMatchObject({
      guardId: "unknown-upload",
      level: "blocking",
    });
    expect(concern?.detail).not.toContain("private failure");
    resetLifecycleCoordinatorForTests();
    await expect(result).resolves.toBe("cancelled");
  });

  it("requires a fresh decision when work changes after review", async () => {
    let detail = "First draft state";
    const proceed = vi.fn();
    registerLifecycleGuard({
      id: "editor",
      label: "Editor",
      inspect: () => ({ level: "warning", detail }),
    });
    const result = requestLifecycleTransition(quitIntent, proceed);
    await settle();
    detail = "A save began after review";

    continueLifecycleTransition();
    await settle();
    expect(proceed).not.toHaveBeenCalled();
    expect(getLifecycleDecisionState()).toMatchObject({
      phase: "review",
      concerns: [{ detail: "A save began after review" }],
    });
    resetLifecycleCoordinatorForTests();
    await expect(result).resolves.toBe("cancelled");
  });

  it("contains transition failures and allows a safe retry", async () => {
    const proceed = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("private native error"))
      .mockResolvedValueOnce();
    const result = requestLifecycleTransition(quitIntent, proceed);
    await settle();
    expect(getLifecycleDecisionState()).toMatchObject({
      phase: "error",
      error: expect.not.stringContaining("private native error"),
    });

    retryLifecycleTransition();
    await expect(result).resolves.toBe("proceeded");
    expect(proceed).toHaveBeenCalledTimes(2);
  });

  it("rejects concurrent lifecycle requests while one decision is open", async () => {
    registerLifecycleGuard({
      id: "draft",
      label: "Draft",
      inspect: () => ({ level: "warning" }),
    });
    const first = requestLifecycleTransition(quitIntent, vi.fn());
    await settle();

    await expect(
      requestLifecycleTransition(
        { ...quitIntent, kind: "sign-out", title: "Sign out?" },
        vi.fn(),
      ),
    ).resolves.toBe("busy");
    resetLifecycleCoordinatorForTests();
    await expect(first).resolves.toBe("cancelled");
  });

  it("turns duplicate owner ids into a recoverable fail-closed concern", async () => {
    const unregisterFirst = registerLifecycleGuard({
      id: "subscriber-editor",
      label: "Subscriber editor A",
      inspect: () => null,
    });
    const unregisterSecond = registerLifecycleGuard({
      id: "subscriber-editor",
      label: "Subscriber editor B",
      inspect: () => null,
    });

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Conflicting lifecycle safety owners",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);

    unregisterFirst();
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);

    // A later same-id mount must collide with the still-registered second
    // instance even though the original map key was removed.
    const unregisterThird = registerLifecycleGuard({
      id: "subscriber-editor",
      label: "Subscriber editor C",
      inspect: () => null,
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { level: "blocking" },
    ]);

    unregisterSecond();
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
    unregisterThird();
  });

  it("bounds OS-shutdown inspection and fails a hung owner closed", async () => {
    vi.useFakeTimers();
    registerLifecycleGuard({
      id: "hung-journal",
      label: "Recoverable journal",
      inspect: () => new Promise(() => undefined),
    });
    const inspection = inspectLifecycle({
      ...quitIntent,
      kind: "os-shutdown",
      disposition: "exit",
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(inspection).resolves.toMatchObject([
      { guardId: "hung-journal", level: "blocking" },
    ]);
    vi.useRealTimers();
  });
});
