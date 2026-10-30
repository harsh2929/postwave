export interface DesktopRouterEnvironment {
  location(): string;
  historyState(): unknown;
  pushState(state: unknown, url: string): void;
  replaceState(state: unknown, url: string): void;
  /**
   * Queue a standards-compatible session-history traversal. Implementations
   * must preserve History API traversal order; native Back/Forward commands
   * must enter the same queue instead of emitting an overtaking, identical
   * popstate that the platform gives JavaScript no request ID to distinguish.
   */
  go(delta: number): void;
  subscribePopState(handler: (state: unknown) => void): () => void;
  getStorage(key: string): string | null;
  setStorage(key: string, value: string): void;
  removeStorage(key: string): void;
}

export function createBrowserDesktopRouterEnvironment(): DesktopRouterEnvironment {
  const hasBrowserHistory =
    typeof window !== "undefined" &&
    typeof window.location?.pathname === "string" &&
    typeof window.history?.pushState === "function" &&
    typeof window.history?.replaceState === "function" &&
    typeof window.addEventListener === "function" &&
    typeof window.removeEventListener === "function";
  if (!hasBrowserHistory) {
    let state: unknown = null;
    let location = "/app/dashboard";
    const storage = new Map<string, string>();
    return {
      location: () => location,
      historyState: () => state,
      pushState: (next, url) => {
        state = next;
        location = url;
      },
      replaceState: (next, url) => {
        state = next;
        location = url;
      },
      go: () => undefined,
      subscribePopState: () => () => undefined,
      getStorage: (key) => storage.get(key) ?? null,
      setStorage: (key, value) => {
        storage.set(key, value);
      },
      removeStorage: (key) => {
        storage.delete(key);
      },
    };
  }
  return {
    location: () =>
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    historyState: () => window.history.state as unknown,
    pushState: (state, url) => {
      window.history.pushState(state, "", url);
    },
    replaceState: (state, url) => {
      window.history.replaceState(state, "", url);
    },
    go: (delta) => window.history.go(delta),
    subscribePopState: (handler) => {
      const listener = (event: PopStateEvent): void => handler(event.state);
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
    getStorage: (key) => window.localStorage?.getItem(key) ?? null,
    setStorage: (key, value) => window.localStorage?.setItem(key, value),
    removeStorage: (key) => window.localStorage?.removeItem(key),
  };
}
