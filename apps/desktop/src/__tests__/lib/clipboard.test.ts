import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  clear: vi.fn<() => Promise<void>>(),
  readText: vi.fn<() => Promise<string>>(),
  writeText:
    vi.fn<(value: string, options?: { label?: string }) => Promise<void>>(),
  isTauri: vi.fn<() => boolean>(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  clear: native.clear,
  readText: native.readText,
  writeText: native.writeText,
}));

vi.mock("../../lib/tauri", () => ({ isTauri: native.isTauri }));

import {
  clipboardAnnouncement,
  resetClipboardTimersForTests,
  SECRET_CLIPBOARD_HISTORY_WARNING,
  writeClipboardText,
} from "../../lib/clipboard";

describe("clipboard service", () => {
  const web = {
    readText: vi.fn<() => Promise<string>>(),
    writeText: vi.fn<(value: string) => Promise<void>>(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    native.isTauri.mockReturnValue(false);
    native.clear.mockResolvedValue(undefined);
    native.readText.mockResolvedValue("");
    native.writeText.mockResolvedValue(undefined);
    web.readText.mockResolvedValue("");
    web.writeText.mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: web });
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    resetClipboardTimersForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("awaits the web backend and returns an exhaustive success", async () => {
    const result = await writeClipboardText("public-url", {
      contentClass: "public",
      label: "Public URL",
    });

    expect(result).toMatchObject({
      ok: true,
      backend: "web",
      contentClass: "public",
      clearScheduled: false,
      historyWarning: null,
    });
    expect(web.writeText).toHaveBeenCalledWith("public-url");
    expect(native.writeText).not.toHaveBeenCalled();
  });

  it("uses the native plugin in Tauri and never duplicates the value to the web API", async () => {
    native.isTauri.mockReturnValue(true);

    const result = await writeClipboardText("native-value", {
      label: "DNS value",
    });

    expect(result).toMatchObject({ ok: true, backend: "native" });
    expect(native.writeText).toHaveBeenCalledWith("native-value", {
      label: "DNS value",
    });
    expect(web.writeText).not.toHaveBeenCalled();
  });

  it("maps platform errors to safe user-facing categories without leaking values", async () => {
    const secret = "pw_live_never-report-this";
    web.writeText.mockRejectedValue(
      new DOMException(`Permission denied for ${secret}`, "NotAllowedError"),
    );

    const result = await writeClipboardText(secret, { contentClass: "secret" });

    expect(result).toMatchObject({
      ok: false,
      category: "permission_denied",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(clipboardAnnouncement(result, "API key")).not.toContain(secret);
  });

  it("reports an unavailable web API instead of fabricating success", async () => {
    vi.stubGlobal("navigator", {});

    await expect(writeClipboardText("value")).resolves.toMatchObject({
      ok: false,
      category: "unavailable",
      retryable: false,
    });
  });

  it("warns for secrets and clears only when the clipboard is unchanged", async () => {
    const secret = "one-time-secret";
    web.readText.mockResolvedValue(secret);
    const result = await writeClipboardText(secret, {
      contentClass: "secret",
      clearIfUnchangedAfterMs: 60_000,
    });

    expect(result).toMatchObject({
      ok: true,
      clearScheduled: true,
      clearAfterMs: 60_000,
      historyWarning: SECRET_CLIPBOARD_HISTORY_WARNING,
    });
    expect(clipboardAnnouncement(result, "Secret")).toContain(
      "cleared in 1 minute if unchanged",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(web.readText).toHaveBeenCalledTimes(1);
    expect(web.writeText).toHaveBeenLastCalledWith("");
  });

  it("preserves a newer clipboard value during secret cleanup", async () => {
    web.readText.mockResolvedValue("newer-value");
    await writeClipboardText("old-secret", {
      contentClass: "secret",
      clearIfUnchangedAfterMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(web.writeText).toHaveBeenCalledTimes(1);
    expect(web.writeText).toHaveBeenCalledWith("old-secret");
  });

  it("uses native read and clear for Tauri clear-if-unchanged", async () => {
    native.isTauri.mockReturnValue(true);
    native.readText.mockResolvedValue("native-secret");

    await writeClipboardText("native-secret", {
      contentClass: "secret",
      clearIfUnchangedAfterMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(native.readText).toHaveBeenCalledTimes(1);
    expect(native.clear).toHaveBeenCalledTimes(1);
    expect(web.readText).not.toHaveBeenCalled();
  });
});
