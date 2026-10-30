// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHECKLIST_GOALS } from "@postwave/onboarding-schema";

import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import {
  freezeOnboardingDecision,
  onboardingAuthorityFromFields,
  onboardingDecisionsKey,
  onboardingProgressKey,
} from "@/lib/onboarding-authority";
import type { RoleKey } from "@/lib/query-keys";
import { useOnboardingDecisions } from "@/lib/use-onboarding-decisions";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const DECISIONS_PATH = "/api/v1/onboarding/steps";
const WHOAMI_PATH = "/api/v1/auth/me";

interface Identity {
  tenantId: string;
  userId: string;
  role: RoleKey;
  viewerMode: boolean;
}

const A: Identity = {
  tenantId: "tenant-a",
  userId: "user-a",
  role: "admin",
  viewerMode: false,
};
const B: Identity = {
  tenantId: "tenant-b",
  userId: "user-b",
  role: "editor",
  viewerMode: false,
};

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  online: { current: "online" },
  serverIdentity: {
    tenantId: "tenant-a",
    userId: "user-a",
    role: "admin" as RoleKey,
    viewerMode: false,
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, put: mocks.apiPut },
  };
});

vi.mock("@/lib/use-online", () => ({
  useOnline: () => mocks.online.current,
}));

vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));

function me(identity: Identity = mocks.serverIdentity) {
  return {
    user_id: identity.userId,
    tenant_id: identity.tenantId,
    email: `${identity.userId}@example.test`,
    role: identity.role,
    effective_role: identity.role,
    viewer_mode: identity.viewerMode,
    auth_provider: "password",
    email_verified: true,
    workspace_name: identity.tenantId,
    workspace_slug: identity.tenantId,
  };
}

function RuntimeProbe(identity: Identity): JSX.Element {
  const runtime = useOnboardingDecisions(identity);
  const state = runtime.decisions?.steps?.surface?.state ?? "none";
  return (
    <div
      data-testid="runtime"
      data-authority={runtime.authority.key}
      data-state={state}
      data-writing={runtime.isWriting ? "true" : "false"}
      data-error={runtime.error?.message ?? ""}
    >
      <button
        type="button"
        data-testid="dismiss"
        onClick={() => {
          void runtime.writeDecision("surface", "dismissed").catch(() => {});
        }}
      />
      <button
        type="button"
        data-testid="snooze"
        onClick={() => {
          void runtime.writeDecision("surface", "snoozed").catch(() => {});
        }}
      />
    </div>
  );
}

function makeRoot(ui: ReactNode): {
  root: Root;
  queryClient: QueryClient;
  rerender: (next: ReactNode) => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: ReactNode): void => {
    act(() => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, next),
      );
    });
  };
  render(ui);
  return { root, queryClient, rerender: render };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function runtime(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[data-testid="runtime"]',
  );
  if (!element) throw new Error("runtime probe missing");
  return element;
}

function click(testId: string): void {
  act(() => {
    document
      .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      ?.click();
  });
}

function setServerIdentity(identity: Identity): void {
  Object.assign(mocks.serverIdentity, identity);
}

function mockChecklistReads(): void {
  mocks.apiGet.mockImplementation((path: string) =>
    Promise.resolve(
      path === DECISIONS_PATH
        ? { steps: {} }
        : {
            steps: CHECKLIST_GOALS.map((goal) => ({
              key: goal.key,
              label: goal.label,
              description: goal.description,
              completed: false,
            })),
            completed: 0,
            total: CHECKLIST_GOALS.length,
            percent: 0,
            all_done: false,
          },
    ),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.online.current = "online";
  setServerIdentity(A);
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("exact-principal onboarding runtime", () => {
  it("drops an aborted late read and purges the previous principal's cache", async () => {
    let releaseA: ((value: unknown) => void) | undefined;
    const aRead = new Promise((resolve) => {
      releaseA = resolve;
    });
    mocks.apiGet.mockImplementation((path: string, options?: unknown) => {
      if (path === DECISIONS_PATH) {
        return mocks.serverIdentity.userId === A.userId
          ? aRead
          : Promise.resolve({ steps: { surface: { state: "snoozed" } } });
      }
      if (path === WHOAMI_PATH) return Promise.resolve(me());
      throw new Error(`unexpected GET ${path} ${String(options)}`);
    });

    const mounted = makeRoot(<RuntimeProbe {...A} />);
    try {
      await waitFor(() => {
        expect(
          mocks.apiGet.mock.calls.some((call) => call[0] === DECISIONS_PATH),
        ).toBe(true);
      });
      const firstSignal = (
        mocks.apiGet.mock.calls.find(
          (call) => call[0] === DECISIONS_PATH,
        )?.[1] as {
          signal: AbortSignal;
        }
      ).signal;

      setServerIdentity(B);
      mounted.rerender(<RuntimeProbe {...B} />);
      await waitFor(() => expect(runtime().dataset.state).toBe("snoozed"));
      await waitFor(() => expect(firstSignal.aborted).toBe(true));

      await act(async () => {
        releaseA?.({ steps: { surface: { state: "dismissed" } } });
        await Promise.resolve();
      });

      expect(runtime().dataset.authority).toBe(
        onboardingAuthorityFromFields(B).key,
      );
      expect(runtime().dataset.state).toBe("snoozed");
      expect(
        mounted.queryClient.getQueryData(
          onboardingDecisionsKey(onboardingAuthorityFromFields(A)),
        ),
      ).toBeUndefined();
      expect(
        mounted.queryClient.getQueryData(
          onboardingDecisionsKey(onboardingAuthorityFromFields(B)),
        ),
      ).toEqual({ steps: { surface: { state: "snoozed" } } });
    } finally {
      releaseA?.({ steps: {} });
      act(() => mounted.root.unmount());
    }
  });

  it("freshly rejects a downgrade before PUT and rolls back the optimistic decision", async () => {
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === DECISIONS_PATH) return Promise.resolve({ steps: {} });
      if (path === WHOAMI_PATH) {
        return Promise.resolve(me({ ...A, role: "viewer", viewerMode: true }));
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const mounted = makeRoot(<RuntimeProbe {...A} />);
    try {
      await waitFor(() => expect(runtime().dataset.state).toBe("none"));
      click("dismiss");
      await waitFor(() => {
        expect(runtime().dataset.error).toMatch(/identity|access changed/i);
      });
      expect(mocks.apiPut).not.toHaveBeenCalled();
      expect(runtime().dataset.state).toBe("none");
      const whoamiCall = mocks.apiGet.mock.calls.find(
        (call) => call[0] === WHOAMI_PATH,
      );
      expect(whoamiCall?.[1]).toEqual(
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          requireOnline: true,
          maxAttempts: 1,
        }),
      );
    } finally {
      act(() => mounted.root.unmount());
    }
  });

  it("freezes intent and admits only one same-tick write with one owned signal", async () => {
    const store: Record<string, unknown> = {};
    let releasePut: (() => void) | undefined;
    const pendingPut = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === WHOAMI_PATH) return Promise.resolve(me(A));
      if (path === DECISIONS_PATH) {
        return Promise.resolve({ steps: { ...store } });
      }
      throw new Error(`unexpected GET ${path}`);
    });
    mocks.apiPut.mockImplementation(
      (_path: string, body: { step_key: string; state: string }) => {
        store[body.step_key] = { state: body.state };
        return pendingPut;
      },
    );

    const intent = freezeOnboardingDecision("surface", "dismissed", "  why  ");
    expect(Object.isFrozen(intent)).toBe(true);
    expect(intent).toEqual({
      stepKey: "surface",
      state: "dismissed",
      reason: "why",
    });
    expect(Reflect.set(intent, "state", "snoozed")).toBe(false);

    const mounted = makeRoot(<RuntimeProbe {...A} />);
    try {
      await waitFor(() => expect(runtime().dataset.state).toBe("none"));
      act(() => {
        document
          .querySelector<HTMLButtonElement>('[data-testid="dismiss"]')
          ?.click();
        document
          .querySelector<HTMLButtonElement>('[data-testid="snooze"]')
          ?.click();
      });
      await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));

      const putOptions = mocks.apiPut.mock.calls[0]?.[2] as {
        signal: AbortSignal;
        requireOnline: boolean;
        maxAttempts: number;
        idempotencyKey: string;
      };
      const whoamiOptions = mocks.apiGet.mock.calls.find(
        (call) => call[0] === WHOAMI_PATH,
      )?.[1] as { signal: AbortSignal };
      expect(putOptions).toEqual(
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          requireOnline: true,
          maxAttempts: 1,
          idempotencyKey: expect.stringMatching(/^[0-9a-f-]+$/i),
        }),
      );
      expect(whoamiOptions.signal).toBe(putOptions.signal);

      await act(async () => {
        releasePut?.();
        await pendingPut;
      });
      await waitFor(() => expect(runtime().dataset.state).toBe("dismissed"));
      expect(mocks.apiPut).toHaveBeenCalledTimes(1);
      expect(runtime().dataset.error).toBe("");
    } finally {
      releasePut?.();
      act(() => mounted.root.unmount());
    }
  });

  it("aborts an owned write on identity change and suppresses its late result", async () => {
    let releasePut: (() => void) | undefined;
    const pendingPut = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === WHOAMI_PATH) return Promise.resolve(me());
      if (path === DECISIONS_PATH) {
        return Promise.resolve({
          steps:
            mocks.serverIdentity.userId === B.userId
              ? { surface: { state: "snoozed" } }
              : {},
        });
      }
      throw new Error(`unexpected GET ${path}`);
    });
    mocks.apiPut.mockReturnValue(pendingPut);

    const mounted = makeRoot(<RuntimeProbe {...A} />);
    try {
      await waitFor(() => expect(runtime().dataset.state).toBe("none"));
      click("dismiss");
      await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
      const oldSignal = (
        mocks.apiPut.mock.calls[0]?.[2] as { signal: AbortSignal }
      ).signal;

      setServerIdentity(B);
      mounted.rerender(<RuntimeProbe {...B} />);
      await waitFor(() => expect(oldSignal.aborted).toBe(true));
      await waitFor(() => expect(runtime().dataset.state).toBe("snoozed"));

      await act(async () => {
        releasePut?.();
        await pendingPut;
        await Promise.resolve();
      });
      expect(runtime().dataset.authority).toBe(
        onboardingAuthorityFromFields(B).key,
      );
      expect(runtime().dataset.state).toBe("snoozed");
      expect(runtime().dataset.error).toBe("");
    } finally {
      releasePut?.();
      act(() => mounted.root.unmount());
    }
  });

  it("contains an aborted write after the exact principal returns", async () => {
    let rejectPut: ((reason: Error) => void) | undefined;
    const pendingPut = new Promise<void>((_resolve, reject) => {
      rejectPut = reject;
    });
    let initialARead = true;
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === WHOAMI_PATH) return Promise.resolve(me());
      if (path === DECISIONS_PATH) {
        if (mocks.serverIdentity.userId === B.userId) {
          return Promise.resolve({ steps: {} });
        }
        if (initialARead) {
          initialARead = false;
          return Promise.resolve({ steps: {} });
        }
        return Promise.resolve({
          steps: { surface: { state: "snoozed" } },
        });
      }
      throw new Error(`unexpected GET ${path}`);
    });
    mocks.apiPut.mockReturnValue(pendingPut);

    const mounted = makeRoot(<RuntimeProbe {...A} />);
    try {
      await waitFor(() => expect(runtime().dataset.state).toBe("none"));
      click("dismiss");
      await waitFor(() => expect(mocks.apiPut).toHaveBeenCalledTimes(1));
      const oldSignal = (
        mocks.apiPut.mock.calls[0]?.[2] as { signal: AbortSignal }
      ).signal;

      setServerIdentity(B);
      mounted.rerender(<RuntimeProbe {...B} />);
      await waitFor(() => expect(oldSignal.aborted).toBe(true));

      setServerIdentity(A);
      mounted.rerender(<RuntimeProbe {...A} />);
      await waitFor(() => expect(runtime().dataset.state).toBe("snoozed"));
      expect(runtime().dataset.writing).toBe("false");

      await act(async () => {
        rejectPut?.(new Error("late old-principal failure"));
        await pendingPut.catch(() => undefined);
      });
      await waitFor(() => expect(runtime().dataset.writing).toBe("false"));
      expect(runtime().dataset.state).toBe("snoozed");
      expect(runtime().dataset.error).toBe("");
      expect(
        mounted.queryClient.getQueryData(
          onboardingDecisionsKey(onboardingAuthorityFromFields(A)),
        ),
      ).toEqual({ steps: { surface: { state: "snoozed" } } });
    } finally {
      rejectPut?.(new Error("cleanup"));
      act(() => mounted.root.unmount());
    }
  });
});

describe("read-only checklist controls", () => {
  it("purges both exact-principal caches on an identity switch", async () => {
    mockChecklistReads();
    const mounted = makeRoot(
      <OnboardingChecklist
        tenantId={A.tenantId}
        userId={A.userId}
        role={A.role}
        viewerMode={A.viewerMode}
      />,
    );
    const aAuthority = onboardingAuthorityFromFields(A);
    const bAuthority = onboardingAuthorityFromFields(B);
    try {
      await waitFor(() => {
        expect(
          mounted.queryClient.getQueryData(onboardingProgressKey(aAuthority)),
        ).toBeDefined();
        expect(
          mounted.queryClient.getQueryData(onboardingDecisionsKey(aAuthority)),
        ).toBeDefined();
      });

      setServerIdentity(B);
      mounted.rerender(
        <OnboardingChecklist
          tenantId={B.tenantId}
          userId={B.userId}
          role={B.role}
          viewerMode={B.viewerMode}
        />,
      );
      await waitFor(() => {
        expect(
          mounted.queryClient.getQueryData(onboardingProgressKey(bAuthority)),
        ).toBeDefined();
        expect(
          mounted.queryClient.getQueryData(onboardingDecisionsKey(bAuthority)),
        ).toBeDefined();
      });
      expect(
        mounted.queryClient.getQueryData(onboardingProgressKey(aAuthority)),
      ).toBeUndefined();
      expect(
        mounted.queryClient.getQueryData(onboardingDecisionsKey(aAuthority)),
      ).toBeUndefined();
    } finally {
      act(() => mounted.root.unmount());
    }
  });

  it("keeps every setup CTA non-actionable in viewer mode", async () => {
    mockChecklistReads();
    const mounted = makeRoot(
      <OnboardingChecklist
        tenantId="tenant-a"
        userId="user-a"
        role="owner"
        viewerMode
      />,
    );
    try {
      await waitFor(() => {
        expect(
          document.querySelector(
            '[data-testid="onboarding-checklist-read-only"]',
          ),
        ).not.toBeNull();
      });
      expect(
        document.querySelector('[data-testid="onboarding-checklist-dismiss"]'),
      ).toBeNull();
      expect(
        document.querySelectorAll('[data-testid="onboarding-goal"] a'),
      ).toHaveLength(0);
      expect(
        document.querySelectorAll(
          '[data-testid^="onboarding-goal-read-only-"]',
        ),
      ).toHaveLength(CHECKLIST_GOALS.length);
      expect(mocks.apiPut).not.toHaveBeenCalled();
    } finally {
      act(() => mounted.root.unmount());
    }
  });

  it("lets editors open sending tasks but not workspace settings", async () => {
    mockChecklistReads();
    const mounted = makeRoot(
      <OnboardingChecklist
        tenantId="tenant-a"
        userId="user-a"
        role="editor"
        viewerMode={false}
      />,
    );
    try {
      await waitFor(() => {
        expect(
          document.querySelector('[data-testid="onboarding-checklist"]'),
        ).not.toBeNull();
      });
      for (const goal of CHECKLIST_GOALS) {
        const row = document.querySelector(`[data-goal-key="${goal.key}"]`);
        expect(row, goal.key).not.toBeNull();
        if (goal.ctaRouteKey.startsWith("settings.")) {
          expect(row?.querySelector("a"), goal.key).toBeNull();
          expect(
            row?.querySelector(
              `[data-testid="onboarding-goal-read-only-${goal.key}"]`,
            ),
            goal.key,
          ).not.toBeNull();
        } else {
          expect(row?.querySelector("a"), goal.key).not.toBeNull();
        }
      }
    } finally {
      act(() => mounted.root.unmount());
    }
  });

  it("disables decision controls offline without attempting a write", async () => {
    mocks.online.current = "offline";
    mockChecklistReads();
    const mounted = makeRoot(
      <OnboardingChecklist
        tenantId="tenant-a"
        userId="user-a"
        role="owner"
        viewerMode={false}
      />,
    );
    try {
      await waitFor(() => {
        expect(
          document.querySelector<HTMLButtonElement>(
            '[data-testid="onboarding-checklist-dismiss"]',
          ),
        ).not.toBeNull();
      });
      const dismiss = document.querySelector<HTMLButtonElement>(
        '[data-testid="onboarding-checklist-dismiss"]',
      );
      expect(dismiss?.disabled).toBe(true);
      expect(dismiss?.title).toMatch(/reconnect/i);
      click("onboarding-checklist-dismiss");
      expect(mocks.apiPut).not.toHaveBeenCalled();
      expect(
        mocks.apiGet.mock.calls
          .filter((call) => call[0] === DECISIONS_PATH)
          .every((call) =>
            expect
              .objectContaining({
                requireOnline: true,
                maxAttempts: 1,
                signal: expect.any(AbortSignal),
              })
              .asymmetricMatch(call[1]),
          ),
      ).toBe(true);
      const progressOptions = mocks.apiGet.mock.calls.find(
        (call) => call[0] === "/api/v1/onboarding-progress",
      )?.[1];
      expect(progressOptions).toEqual(
        expect.objectContaining({
          requireOnline: true,
          maxAttempts: 1,
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      act(() => mounted.root.unmount());
    }
  });
});
