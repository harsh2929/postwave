/**
 * The audit tail's socket is held only while the app is in front of the user.
 *
 * NATIVE#10 (lib/eventStreamLifecycle): `isProbablyOnline()` stays true while
 * backgrounded, so an ungated stream leaves Android holding the socket and its
 * reconnect timers alive burning radio, and leaves iOS suspending it half-open
 * — after which the stall watchdog reconnects and re-mints a stream token
 * against a socket the OS has already torn down. `lib/eventCacheSync` has
 * honoured this for the event bus since; this hook's stream did not.
 *
 * The asymmetry is what made it a defect rather than a preference: the POLL in
 * this same hook is already foreground-only (`refetchIntervalInBackground:
 * false`), so before this the cheap half respected the rule and the expensive
 * half did not.
 */
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { FocusGate } from "@/lib/eventStreamLifecycle";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const opens = vi.hoisted(() => ({ count: 0, stops: 0 }));

vi.mock("@/api/auditStream", () => ({
  connectAuditStream: () => {
    opens.count += 1;
    return () => {
      opens.stops += 1;
    };
  },
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: () => ({
    enabled: true,
    baseUrl: "https://api.test.example",
    tenantId: "tenant_1",
    userId: "user_1",
    effectiveRole: "admin",
    canReadOfflineSnapshots: true,
  }),
}));

vi.mock("@/hooks/useAudit", () => ({
  auditLogPath: () => "/api/v1/audit?limit=50",
  normalizeAuditPage: () => ({ rows: [] }),
}));

vi.mock("@/api/client", () => ({
  getClient: () => ({ client: { request: () => Promise.resolve({}) } }),
}));

const { useAuditTail } = await import("./useAuditTail");

/** A FocusGate we drive by hand, standing in for the AppState bridge. */
function fakeFocus(initial: boolean): FocusGate & { set(f: boolean): void } {
  let focused = initial;
  const listeners = new Set<(f: boolean) => void>();
  return {
    isFocused: () => focused,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: boolean) {
      focused = next;
      for (const l of [...listeners]) l(next);
    },
  };
}

function render(focus: FocusGate) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Probe() {
    useAuditTail({ enabled: true, newestId: 10, filters: {}, focus });
    return null;
  }
  let tree: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return tree as unknown as TestRenderer.ReactTestRenderer;
}

describe("useAuditTail stream lifecycle", () => {
  beforeEach(() => {
    opens.count = 0;
    opens.stops = 0;
  });

  it("opens the stream while the app is foregrounded", () => {
    const focus = fakeFocus(true);
    const tree = render(focus);
    expect(opens.count).toBe(1);
    expect(opens.stops).toBe(0);
    act(() => tree.unmount());
  });

  it("does not open a socket at all when the app starts backgrounded", () => {
    const focus = fakeFocus(false);
    const tree = render(focus);
    expect(opens.count).toBe(0);
    act(() => tree.unmount());
  });

  it("releases the socket when the app backgrounds, and re-opens on return", () => {
    const focus = fakeFocus(true);
    const tree = render(focus);
    expect(opens.count).toBe(1);

    act(() => focus.set(false));
    expect(opens.stops).toBe(1);
    expect(opens.count).toBe(1);

    act(() => focus.set(true));
    expect(opens.count).toBe(2);
    expect(opens.stops).toBe(1);

    act(() => tree.unmount());
    expect(opens.stops).toBe(2);
  });
});
