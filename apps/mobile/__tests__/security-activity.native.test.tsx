import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { router } from "expo-router";

/**
 * AUTH#8, half (b): the recent-security-activity card that apps/web inlines
 * beside its security controls and mobile had nowhere.
 *
 * What is pinned here is the thing a security card can most easily get wrong:
 * a read that FAILED, or a session that is offline, must not render as
 * "nothing happened". On a screen whose whole job is reassurance those two are
 * opposite answers, and they look identical if the ladder is a nested ternary.
 *
 * HARNESS NOTE, because it cost a debugging cycle and will cost the next
 * person one too: `@/hooks/useAudit` and `@/hooks/useOnlineQueryGate` BOTH
 * resolve to __tests__/mocks/queryHooks.cjs through one moduleNameMapper
 * alternation, so they are the SAME module object at runtime. A
 * `jest.mock("@/hooks/useAudit", …)` therefore replaces the online-gate
 * harness as well and `__resetOnlineGateForTests` disappears. Drive both
 * through the shared proxy's `__setHookResultForTests` instead.
 */
// eslint-disable-next-line import/first
import * as QueryHooks from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import { SecurityActivitySection } from "@/components/settings/SecurityActivitySection";

const harness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    action: "user.login.succeeded",
    actorType: "user",
    actorLabel: "ada@example.test",
    ip: "203.0.113.4",
    metadata: {},
    at: "2026-07-20T09:00:00Z",
    ...over,
  };
}

function pages(rows: unknown[]) {
  return { pages: [{ rows, nextCursor: null }] };
}

/** Matches the real `useAuditLog` return shape the card reads. */
function auditResult(
  over: { data?: unknown; isLoading?: boolean; isError?: boolean } = {},
) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: jest.fn(async () => undefined),
    ...over,
  };
}

async function renderCard() {
  return await render(React.createElement(SecurityActivitySection), {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

/**
 * `canRead` mirrors `hasAuditReadScope`'s three-valued answer exactly:
 * null = the ungated /audit/my-scopes call has not returned yet.
 */
function reset(
  canRead: boolean | null,
  audit: ReturnType<typeof auditResult> = auditResult(),
) {
  harness.__resetOnlineGateForTests();
  harness.__resetHookResultsForTests();
  harness.__setHookResultForTests("hasAuditReadScope", canRead);
  harness.__setHookResultForTests("useAuditScopes", { data: undefined });
  harness.__setHookResultForTests("useAuditLog", audit);
  (router.push as unknown as { mockClear?: () => void }).mockClear?.();
}

describe("security activity — the scope gate", () => {
  it("renders nothing at all without audit:read", async () => {
    reset(false);
    const screen = await renderCard();
    expect(screen.queryByText("Recent security activity")).toBeNull();
  });

  it("stays silent while the scope answer is still in flight", async () => {
    reset(null);
    const screen = await renderCard();
    expect(screen.queryByText("Recent security activity")).toBeNull();
  });
});

describe("security activity — 'we couldn't look' is never 'all clear'", () => {
  it("says the read failed rather than showing an empty history", async () => {
    reset(true, auditResult({ isError: true }));
    const screen = await renderCard();
    expect(
      screen.getByText(/Couldn't read recent security activity/i),
    ).toBeTruthy();
    expect(screen.queryByText(/No sign-ins/i)).toBeNull();
  });

  it("says OFFLINE rather than claiming nothing happened", async () => {
    reset(true);
    harness.__setOnlineGateForTests({ enabled: false, isOnline: false });
    const screen = await renderCard();
    expect(screen.getByText(/offline/i)).toBeTruthy();
    expect(screen.queryByText(/No sign-ins/i)).toBeNull();
  });

  it("claims an empty history only on a loaded, online, successful read", async () => {
    reset(true, auditResult({ data: pages([]) }));
    const screen = await renderCard();
    expect(screen.getByText(/No sign-ins/i)).toBeTruthy();
  });
});

describe("security activity — what it shows", () => {
  it("keeps only security rows and names them in prose", async () => {
    reset(
      true,
      auditResult({
        data: pages([
          row({ id: 1, action: "user.login.succeeded" }),
          row({ id: 2, action: "campaign.sent" }),
        ]),
      }),
    );
    const screen = await renderCard();
    expect(screen.getByText("User login succeeded")).toBeTruthy();
    expect(screen.queryByText("Campaign sent")).toBeNull();
  });

  it("carries the actor and the IP, not a bare timestamp", async () => {
    reset(true, auditResult({ data: pages([row()]) }));
    const screen = await renderCard();
    expect(screen.getByText(/ada@example\.test · 203\.0\.113\.4/)).toBeTruthy();
  });

  it("caps the glance at five rows", async () => {
    reset(
      true,
      auditResult({
        data: pages(
          Array.from({ length: 9 }, (_, i) =>
            row({
              id: i,
              action: `user.login.succeeded.${i}`,
              at: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
            }),
          ),
        ),
      }),
    );
    const screen = await renderCard();
    expect(screen.getAllByText(/^User login succeeded/)).toHaveLength(5);
  });

  it("hands off to the audit tab WITH the security lens, not to the raw log", async () => {
    reset(true, auditResult({ data: pages([row()]) }));
    const screen = await renderCard();
    await fireEvent.press(
      screen.getByLabelText("Open the audit log filtered to security events"),
    );
    expect(router.push).toHaveBeenCalledWith("/(tabs)/audit?lens=security");
  });
});
