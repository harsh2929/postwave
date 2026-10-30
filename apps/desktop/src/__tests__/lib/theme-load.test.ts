/**
 * DUX-037 theme contract: System is a durable preference, resolves safely at
 * boot, follows OS changes live, and synchronizes between desktop windows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const LS_KEY = "postwave_theme";

interface FakeStorage {
  store: Map<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  clear(): void;
}

interface FakeMediaQuery {
  matches: boolean;
  media: string;
  addEventListener: (
    type: string,
    listener: (event: MediaQueryListEvent) => void,
  ) => void;
  removeEventListener: () => void;
  emit(matches: boolean): void;
}

interface InstalledThemeEnvironment {
  storage: FakeStorage;
  media: FakeMediaQuery | null;
  attributes: Map<string, string>;
  emitStorage(value: string | null): void;
}

function makeStorage(): FakeStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    clear: () => void store.clear(),
  };
}

function makeMediaQuery(prefersLight: boolean): FakeMediaQuery {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  return {
    matches: prefersLight,
    media: "(prefers-color-scheme: light)",
    addEventListener(type, listener) {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: () => undefined,
    emit(matches) {
      this.matches = matches;
      const event = { matches } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function installThemeEnvironment(opts: {
  stored?: string;
  prefersLight?: boolean;
  withoutMatchMedia?: boolean;
}): InstalledThemeEnvironment {
  const storage = makeStorage();
  if (opts.stored !== undefined) storage.setItem(LS_KEY, opts.stored);
  const media = opts.withoutMatchMedia
    ? null
    : makeMediaQuery(opts.prefersLight === true);
  const storageListeners = new Set<(event: StorageEvent) => void>();
  const attributes = new Map<string, string>();

  const win = {
    localStorage: storage,
    matchMedia: media ? () => media : undefined,
    addEventListener(type: string, listener: (event: StorageEvent) => void) {
      if (type === "storage") storageListeners.add(listener);
    },
  };
  const doc = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
      removeAttribute(name: string) {
        attributes.delete(name);
      },
    },
  };

  // @ts-expect-error — intentionally installing the minimum browser contract.
  globalThis.window = win;
  // @ts-expect-error — intentionally installing the minimum DOM contract.
  globalThis.document = doc;

  return {
    storage,
    media,
    attributes,
    emitStorage(value) {
      if (value === null) storage.store.delete(LS_KEY);
      else storage.setItem(LS_KEY, value);
      const event = { key: LS_KEY, newValue: value } as StorageEvent;
      for (const listener of storageListeners) listener(event);
    },
  };
}

async function freshStore(): Promise<typeof import("../../lib/store")> {
  vi.resetModules();
  vi.doMock("../../lib/api-client", () => ({
    api: {},
    apiAuth: { reset: vi.fn() },
    clearApiConfig: vi.fn(),
  }));
  return import("../../lib/store");
}

afterEach(() => {
  // @ts-expect-error — clear the intentionally minimal browser stub.
  delete globalThis.window;
  // @ts-expect-error — clear the intentionally minimal DOM stub.
  delete globalThis.document;
  vi.restoreAllMocks();
});

describe("desktop theme preference", () => {
  it.each(["system", "light", "dark"] as const)(
    "loads the persisted %s preference",
    async (preference) => {
      installThemeEnvironment({ stored: preference });
      const store = await freshStore();
      expect(store.loadThemePreference()).toBe(preference);
    },
  );

  it("keeps explicit Light and Dark independent of the OS palette", async () => {
    installThemeEnvironment({ stored: "light", prefersLight: false });
    let store = await freshStore();
    expect(store.loadTheme()).toBe("light");

    installThemeEnvironment({ stored: "dark", prefersLight: true });
    store = await freshStore();
    expect(store.loadTheme()).toBe("dark");
  });

  it("migrates missing and invalid preferences to System", async () => {
    installThemeEnvironment({ prefersLight: true });
    let store = await freshStore();
    expect(store.loadThemePreference()).toBe("system");
    expect(store.loadTheme()).toBe("light");

    installThemeEnvironment({ stored: "sepia", prefersLight: true });
    store = await freshStore();
    expect(store.loadThemePreference()).toBe("system");
    expect(store.loadTheme()).toBe("light");
  });

  it("falls back to Dark when the OS media query is unavailable", async () => {
    installThemeEnvironment({ withoutMatchMedia: true });
    const store = await freshStore();
    expect(store.loadThemePreference()).toBe("system");
    expect(store.loadTheme()).toBe("dark");
  });

  it("keeps an in-memory preference when localStorage is denied", async () => {
    const env = installThemeEnvironment({ prefersLight: false });
    env.storage.getItem = () => {
      throw new Error("storage denied");
    };
    env.storage.setItem = () => {
      throw new Error("storage denied");
    };
    const store = await freshStore();

    expect(store.loadThemePreference()).toBe("system");
    expect(() => store.setThemePreference("light")).not.toThrow();
    expect(env.attributes.get("data-theme")).toBe("light");
    expect(env.attributes.get("data-theme-preference")).toBe("light");
  });

  it("persists System and follows OS palette changes live", async () => {
    const env = installThemeEnvironment({ prefersLight: false });
    const store = await freshStore();

    store.setThemePreference("system");
    expect(env.storage.getItem(LS_KEY)).toBe("system");
    expect(env.attributes.get("data-theme-preference")).toBe("system");
    expect(env.attributes.has("data-theme")).toBe(false);

    env.media?.emit(true);
    expect(env.attributes.get("data-theme")).toBe("light");
    expect(env.attributes.get("data-theme-preference")).toBe("system");

    env.media?.emit(false);
    expect(env.attributes.has("data-theme")).toBe(false);
  });

  it("does not let OS changes override an explicit palette", async () => {
    const env = installThemeEnvironment({ prefersLight: false });
    const store = await freshStore();
    store.setThemePreference("light");

    env.media?.emit(false);
    expect(env.attributes.get("data-theme")).toBe("light");
    expect(env.attributes.get("data-theme-preference")).toBe("light");
  });

  it("applies preference changes received from another app window", async () => {
    const env = installThemeEnvironment({ stored: "dark", prefersLight: true });
    await freshStore();

    env.emitStorage("light");
    expect(env.attributes.get("data-theme")).toBe("light");
    expect(env.attributes.get("data-theme-preference")).toBe("light");

    env.emitStorage("system");
    expect(env.attributes.get("data-theme")).toBe("light");
    expect(env.attributes.get("data-theme-preference")).toBe("system");

    env.media?.emit(false);
    expect(env.attributes.has("data-theme")).toBe(false);
  });

  it("treats removed or malformed cross-window values as System", async () => {
    const env = installThemeEnvironment({ stored: "light", prefersLight: false });
    await freshStore();

    env.emitStorage("unknown");
    expect(env.attributes.get("data-theme-preference")).toBe("system");
    expect(env.attributes.has("data-theme")).toBe(false);

    env.emitStorage(null);
    expect(env.attributes.get("data-theme-preference")).toBe("system");
  });
});
