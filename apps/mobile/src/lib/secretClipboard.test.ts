/**
 * The webhook signing secret used to sit on the iOS general pasteboard with no
 * expiry, which means Universal Clipboard also handed it to every paired Mac.
 * These tests pin the timer that takes it back, and — more importantly — pin
 * the three cases where it must NOT act, because a self-clearing secret that
 * eats an unrelated clipboard is a worse bug than the one it fixes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setStringAsync = vi.fn<(value: string) => Promise<boolean>>();
const getStringAsync = vi.fn<() => Promise<string>>();
const removeListener = vi.fn();
let appStateHandler: ((state: string) => void) | null = null;

vi.mock("expo-clipboard", () => ({
  setStringAsync: (value: string) => setStringAsync(value),
  getStringAsync: () => getStringAsync(),
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, handler: (state: string) => void) => {
      appStateHandler = handler;
      return { remove: removeListener };
    },
  },
}));

const SECRET = "whsec_9f3c1a7e";

beforeEach(() => {
  vi.useFakeTimers();
  setStringAsync.mockReset().mockResolvedValue(true);
  getStringAsync.mockReset().mockResolvedValue(SECRET);
  removeListener.mockReset();
  appStateHandler = null;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the pending clipboard promises settle inside fake timers. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("copySecretToClipboard", () => {
  it("clears the secret once the window is up", async () => {
    const { copySecretToClipboard } = await import("./secretClipboard");

    const { copied } = await copySecretToClipboard(SECRET, 90_000);
    expect(copied).toBe(true);
    expect(setStringAsync).toHaveBeenCalledWith(SECRET);

    // Nothing happens early — the operator is still pasting.
    await vi.advanceTimersByTimeAsync(89_000);
    expect(setStringAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(setStringAsync).toHaveBeenLastCalledWith("");
    // The listener comes down with it; this handle outlives the component that
    // opened it, so leaking it leaks for the rest of the process.
    expect(removeListener).toHaveBeenCalled();
  });

  it("leaves a clipboard the operator has since used for something else", async () => {
    const { copySecretToClipboard } = await import("./secretClipboard");

    await copySecretToClipboard(SECRET, 90_000);
    getStringAsync.mockResolvedValue("https://example.invalid/some-other-copy");

    await vi.advanceTimersByTimeAsync(91_000);

    // One call: the original copy. No write of "".
    expect(setStringAsync).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalled();
  });

  it("stays armed when the read is refused, and finishes on foreground", async () => {
    const { copySecretToClipboard } = await import("./secretClipboard");

    await copySecretToClipboard(SECRET, 90_000);
    // Android >=10 refuses a background read and resolves EMPTY rather than
    // throwing — indistinguishable from "they cleared it", so we must not
    // treat it as licence to write, nor stand down.
    getStringAsync.mockResolvedValue("");
    await vi.advanceTimersByTimeAsync(91_000);
    expect(setStringAsync).toHaveBeenCalledTimes(1);
    expect(removeListener).not.toHaveBeenCalled();

    // Foregrounding is the first moment the read is permitted again.
    getStringAsync.mockResolvedValue(SECRET);
    appStateHandler?.("active");
    await flush();
    expect(setStringAsync).toHaveBeenLastCalledWith("");
  });

  it("does not act on a foreground that happens before the window is up", async () => {
    const { copySecretToClipboard } = await import("./secretClipboard");

    await copySecretToClipboard(SECRET, 90_000);
    appStateHandler?.("active");
    await flush();

    expect(setStringAsync).toHaveBeenCalledTimes(1);
  });

  it("cancels cleanly when a second copy supersedes the first", async () => {
    const { copySecretToClipboard } = await import("./secretClipboard");

    const { cancel } = await copySecretToClipboard(SECRET, 90_000);
    cancel();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(setStringAsync).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalled();
  });

  it("schedules nothing when the write never landed", async () => {
    const { copySecretToClipboard } = await import("./secretClipboard");
    setStringAsync.mockResolvedValue(false);

    const { copied } = await copySecretToClipboard(SECRET, 90_000);
    expect(copied).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    // A timer here would clear a clipboard this module never wrote to.
    expect(setStringAsync).toHaveBeenCalledTimes(1);
    expect(appStateHandler).toBeNull();
  });
});
