/**
 * theme.test.tsx — SHELL#50: the provider must never paint a frame in the
 * wrong theme.
 *
 * Runs in the node environment (like BiometricGate.test.tsx) by mocking the
 * two native surfaces theme.ts touches — `react-native`'s useColorScheme and
 * `expo-secure-store` — and rendering the REAL provider with
 * react-test-renderer. Every render is appended to a log, so "was there ever a
 * dark frame?" is an assertion about the whole render history rather than
 * about the final state, which is the only way to catch a flash.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dark, light } from "@postwave/design-tokens";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "postwave.theme_pref";

interface SecureStoreMock {
  getItem: ((key: string) => string | null) | undefined;
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
}

const setItemAsync = vi.fn(async () => undefined);

/** Storage whose synchronous read works — the normal device path. */
function syncStore(stored: string | null): SecureStoreMock {
  return {
    getItem: () => stored,
    getItemAsync: async () => stored,
    setItemAsync,
  };
}

/**
 * Storage with no synchronous read at all, and an async read the test
 * releases by hand — the fallback path (older native module, keychain locked
 * before first unlock).
 */
function deferredStore(stored: string | null): {
  store: SecureStoreMock;
  release: () => void;
} {
  let release = (): void => undefined;
  const pending = new Promise<string | null>((resolve) => {
    release = () => resolve(stored);
  });
  return {
    store: {
      getItem: undefined,
      getItemAsync: () => pending,
      setItemAsync,
    },
    release: () => release(),
  };
}

async function loadTheme(
  store: SecureStoreMock,
  systemScheme: "light" | "dark" | null,
) {
  vi.resetModules();
  vi.doMock("expo-secure-store", () => store);
  vi.doMock("react-native", () => ({ useColorScheme: () => systemScheme }));
  return await import("./theme");
}

type ThemeModule = Awaited<ReturnType<typeof loadTheme>>;

/** Renders the provider and records the theme of EVERY committed frame. */
async function mount(mod: ThemeModule) {
  const frames: string[] = [];
  function Probe() {
    const { theme, t, hydrated } = mod.useTheme();
    frames.push(`${theme}:${t.bg}:${hydrated ? "hydrated" : "pending"}`);
    return createElement("probe", { theme });
  }
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(mod.ThemeProvider, null, createElement(Probe)),
    );
  });
  return { frames, renderer: renderer as unknown as TestRenderer.ReactTestRenderer };
}

beforeEach(() => {
  setItemAsync.mockClear();
});

afterEach(() => {
  vi.doUnmock("expo-secure-store");
  vi.doUnmock("react-native");
});

describe("first paint honours the STORED preference, not the OS", () => {
  it("never paints a dark frame for a light-preference user on a dark device", async () => {
    const mod = await loadTheme(syncStore("light"), "dark");
    const { frames } = await mount(mod);

    // The reported bug was a dark flash. Assert the render HISTORY, not the
    // end state: the old provider also ended up light.
    expect(frames).toEqual([`light:${light.bg}:hydrated`]);
    expect(frames.some((f) => f.startsWith("dark"))).toBe(false);
  });

  it("never paints a light frame for a dark-preference user on a light device", async () => {
    const mod = await loadTheme(syncStore("dark"), "light");
    const { frames } = await mount(mod);
    expect(frames).toEqual([`dark:${dark.bg}:hydrated`]);
  });

  it("treats a missing stored value as the 'system' answer and paints at once", async () => {
    // Nothing stored is an ANSWER (follow the OS), not an unknown — a
    // first-run user must not be gated waiting for a value that isn't there.
    const mod = await loadTheme(syncStore(null), "light");
    const { frames } = await mount(mod);
    expect(frames).toEqual([`light:${light.bg}:hydrated`]);
  });

  it("ignores a stored value it does not recognise", async () => {
    const mod = await loadTheme(syncStore("solarized"), "light");
    const { frames } = await mount(mod);
    expect(frames).toEqual([`light:${light.bg}:hydrated`]);
  });
});

describe("gate: nothing is painted while the preference is unknown", () => {
  it("renders no children until the async read answers, then renders light", async () => {
    const { store, release } = deferredStore("light");
    const mod = await loadTheme(store, "dark");
    const { frames, renderer } = await mount(mod);

    // The window that used to produce the flash: system says dark, stored
    // preference not yet known. Nothing is committed at all.
    expect(frames).toEqual([]);
    expect(renderer.toJSON()).toBeNull();

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(frames).toEqual([`light:${light.bg}:hydrated`]);
    expect(frames.some((f) => f.startsWith("dark"))).toBe(false);
  });

  it("falls back to 'system' rather than gating forever when storage throws", async () => {
    const mod = await loadTheme(
      {
        getItem: () => {
          throw new Error("keychain locked");
        },
        getItemAsync: () => Promise.reject(new Error("keychain locked")),
        setItemAsync,
      },
      "light",
    );
    const { frames, renderer } = await mount(mod);
    // A device that cannot answer must still get an app.
    expect(frames).toEqual([`light:${light.bg}:hydrated`]);
    expect(renderer.toJSON()).not.toBeNull();
  });

  it("does not blank the tree again when the provider remounts", async () => {
    // ThemeProvider sits under a keyed PersistQueryClientProvider, so
    // sign-in/sign-out remounts it. The answer is cached for the process.
    const { store, release } = deferredStore("light");
    const mod = await loadTheme(store, "dark");
    const first = await mount(mod);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(first.frames).toEqual([`light:${light.bg}:hydrated`]);

    const second = await mount(mod);
    expect(second.frames).toEqual([`light:${light.bg}:hydrated`]);
    expect(second.renderer.toJSON()).not.toBeNull();
  });
});

describe("changing the preference", () => {
  it("flips the painted theme immediately and persists the choice", async () => {
    const mod = await loadTheme(syncStore("system"), "dark");
    const frames: string[] = [];
    let setPreference: ((next: "light" | "dark" | "system") => void) | null =
      null;
    function Probe() {
      const ctx = mod.useTheme();
      setPreference = ctx.setPreference;
      frames.push(ctx.theme);
      return createElement("probe", null);
    }
    await act(async () => {
      TestRenderer.create(
        createElement(mod.ThemeProvider, null, createElement(Probe)),
      );
    });
    expect(frames).toEqual(["dark"]);

    await act(async () => {
      setPreference?.("light");
    });

    expect(frames.at(-1)).toBe("light");
    expect(setItemAsync).toHaveBeenCalledWith(KEY, "light");
  });
});

describe("useTheme outside the provider", () => {
  it("degrades to dark and reports itself as un-hydrated", async () => {
    // A consumer rendered with no provider above it (AppErrorBoundary's
    // world, and most component tests) must not explode.
    const mod = await loadTheme(syncStore("light"), "light");
    const seen: { theme: string; bg: string; hydrated: boolean }[] = [];
    function Orphan() {
      const ctx = mod.useTheme();
      seen.push({ theme: ctx.theme, bg: ctx.t.bg, hydrated: ctx.hydrated });
      return createElement("probe", null);
    }
    await act(async () => {
      TestRenderer.create(createElement(Orphan));
    });
    expect(seen).toEqual([{ theme: "dark", bg: dark.bg, hydrated: false }]);
  });
});
