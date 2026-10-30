// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Web had NO onboarding decision path — no read, no write, and no control to
// put the getting-started checklist away. Mobile records a dismissal against
// `PUT /api/v1/onboarding/steps`; desktop's state controller carries a
// decision port. Web rendered the card unconditionally, so a person who
// dismissed it on their phone opened the web app and it was back, with nothing
// here to dismiss it with. These tests pin both halves: a decision made
// elsewhere is honoured here, and a decision made here is recorded for the
// person rather than the browser.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKLIST_DECISION_STEP_KEY,
  CHECKLIST_GOALS,
  type OnboardingProgress,
} from "@postwave/onboarding-schema";

import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import {
  onboardingAuthorityFromFields,
  onboardingDecisionsKey,
  onboardingProgressKey,
} from "@/lib/onboarding-authority";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const DECISIONS_PATH = "/api/v1/onboarding/steps";
const WHOAMI_PATH = "/api/v1/auth/me";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  track: vi.fn(),
  identity: {
    tenantId: "tnt_1",
    userId: "usr_1",
    role: "admin",
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

vi.mock("@/lib/telemetry", () => ({ track: mocks.track }));
vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));

function progress(): OnboardingProgress {
  return {
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
  };
}

/**
 * A durable stand-in for the server's `onboarding_step_state` row.
 *
 * Stateful on purpose: a static GET mock would let an optimistic update look
 * correct while the write went nowhere, which is precisely the bug under test.
 * Here the PUT has to land for the post-invalidation refetch to agree.
 */
function serve(decisions: unknown): { steps: Record<string, unknown> } {
  const store = (
    typeof decisions === "object" && decisions !== null
      ? { ...(decisions as { steps?: Record<string, unknown> }) }
      : { steps: {} }
  ) as { steps: Record<string, unknown> };
  mocks.apiGet.mockImplementation((path: string) => {
    if (path === DECISIONS_PATH) {
      return Promise.resolve({ steps: { ...store.steps } });
    }
    if (path === WHOAMI_PATH) {
      return Promise.resolve({
        user_id: mocks.identity.userId,
        tenant_id: mocks.identity.tenantId,
        email: "person@example.test",
        role: mocks.identity.role,
        effective_role: mocks.identity.role,
        viewer_mode: mocks.identity.viewerMode,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Workspace",
        workspace_slug: "workspace",
      });
    }
    return Promise.resolve(progress());
  });
  mocks.apiPut.mockImplementation(
    (_path: string, body: { step_key: string; state: string }) => {
      store.steps = { ...store.steps, [body.step_key]: { state: body.state } };
      return Promise.resolve({ ok: true });
    },
  );
  return store;
}

function render(ui: ReactNode): { queryClient: QueryClient; root: Root } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { queryClient, root };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
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

function mount(role = "admin"): { queryClient: QueryClient; root: Root } {
  mocks.identity.role = role;
  mocks.identity.viewerMode = false;
  return render(
    createElement(OnboardingChecklist, {
      tenantId: "tnt_1",
      userId: "usr_1",
      role,
      viewerMode: false,
    }),
  );
}

/**
 * Resolves once every in-flight query has landed.
 *
 * Needed because "the checklist is on screen" is true before the decisions
 * query answers, so a `waitFor` on it succeeds on the first attempt and asserts
 * nothing about what the server said.
 */
async function settled(queryClient: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(mocks.apiGet).toHaveBeenCalled();
  });
  await waitFor(() => {
    expect(queryClient.isFetching()).toBe(0);
  });
  // isFetching() reaching zero means the DATA landed, not that React has
  // re-rendered with it — asserting here still read the pre-settle paint. Flush
  // the pending state updates so the assertions see the committed tree.
  await act(async () => {
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.identity.tenantId = "tnt_1";
  mocks.identity.userId = "usr_1";
  mocks.identity.role = "admin";
  mocks.identity.viewerMode = false;
  window.localStorage.clear();
  document.body.innerHTML = "";
});

describe("a decision made on another device is honoured here", () => {
  it("hides the checklist when the person dismissed it elsewhere", async () => {
    serve({
      steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "dismissed" } },
    });
    const { root } = mount();
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist-dismissed")).not.toBeNull();
      });
      expect(query("onboarding-checklist")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("honours 'not applicable to us', not only 'dismissed'", async () => {
    // `inapplicable` is in the server's closed vocabulary and means the step
    // is impossible for this account — the exact case where re-asking is worst.
    serve({
      steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "inapplicable" } },
    });
    const { root } = mount();
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist-dismissed")).not.toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the checklist again after a snooze", async () => {
    serve({ steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "snoozed" } } });
    const { queryClient, root } = mount();
    try {
      // WAIT FOR THE DECISION TO ARRIVE BEFORE ASSERTING IT WAS HONOURED.
      //
      // This used to `waitFor` the checklist being present — which is true on
      // the FIRST render, before the decisions query resolves, so waitFor
      // returned on attempt zero and the test passed whatever the server said.
      // Proved by feeding it `dismissed`, a state that unambiguously hides the
      // checklist: still green. A test that cannot fail is not a test.
      //
      // `isFetching() === 0` is the settle signal: nonzero while the query is
      // in flight, zero once it has landed, so the assertions below run against
      // the server's answer rather than the initial paint.
      await settled(queryClient);
      await waitFor(() => {
        expect(query("onboarding-checklist")).not.toBeNull();
        expect(query("onboarding-checklist-dismissed")).toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps the dashboard tour's anchor while hidden", async () => {
    // The tour targets `[data-tour="dashboard-onboarding"]`. Vanishing
    // entirely would leave that step pointing at nothing.
    serve({
      steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "dismissed" } },
    });
    const { root } = mount();
    try {
      await waitFor(() => {
        expect(
          document.querySelector('[data-tour="dashboard-onboarding"]'),
        ).not.toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the checklist when no decision was recorded", async () => {
    serve({ steps: {} });
    const { queryClient, root } = mount();
    try {
      // Same settle requirement as the snooze case above: an absent key means
      // "never decided", and that is only distinguishable from "not loaded yet"
      // once the query has actually answered.
      await settled(queryClient);
      // Query state reaching idle and React committing the matching paint are
      // distinct scheduler turns under load. Poll the rendered contract just
      // as the snoozed-state case above does; the assertion remains exact.
      await waitFor(() => {
        expect(query("onboarding-checklist")).not.toBeNull();
        expect(query("onboarding-checklist-dismissed")).toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("a decision made here is recorded for the person", () => {
  it("writes the dismissal to the shared endpoint", async () => {
    serve({ steps: {} });
    const { root } = mount();
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist-dismiss")).not.toBeNull();
      });
      act(() => {
        query("onboarding-checklist-dismiss")?.click();
      });
      await waitFor(() => {
        expect(mocks.apiPut).toHaveBeenCalledWith(
          DECISIONS_PATH,
          {
            step_key: CHECKLIST_DECISION_STEP_KEY,
            state: "dismissed",
          },
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            requireOnline: true,
            maxAttempts: 1,
            idempotencyKey: expect.any(String),
          }),
        );
      });
      // And it takes effect immediately — a dismiss that waits on a round-trip
      // reads as a broken button.
      await waitFor(() => {
        expect(query("onboarding-checklist-dismissed")).not.toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("writes a snooze to bring it back, not a local-only unhide", async () => {
    serve({
      steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "dismissed" } },
    });
    const { root } = mount();
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist-restore")).not.toBeNull();
      });
      act(() => {
        query("onboarding-checklist-restore")?.click();
      });
      await waitFor(() => {
        expect(mocks.apiPut).toHaveBeenCalledWith(
          DECISIONS_PATH,
          {
            step_key: CHECKLIST_DECISION_STEP_KEY,
            state: "snoozed",
          },
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            requireOnline: true,
            maxAttempts: 1,
            idempotencyKey: expect.any(String),
          }),
        );
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("rolls back a refused decision even when it cannot re-read the server", async () => {
    // The realistic failure: the connection dropped, so the PUT failed AND the
    // reconciling refetch fails too. Nothing but the rollback can undo the
    // optimistic hide, and without it this device would go on claiming a
    // decision the server never took — the next device would disagree, and the
    // disagreement would be invisible here.
    serve({ steps: {} });
    const { root } = mount();
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist-dismiss")).not.toBeNull();
      });
      mocks.apiPut.mockRejectedValue(new Error("403"));
      mocks.apiGet.mockImplementation((path: string) => {
        if (path === DECISIONS_PATH)
          return Promise.reject(new Error("network"));
        if (path === WHOAMI_PATH) {
          return Promise.resolve({
            user_id: "usr_1",
            tenant_id: "tnt_1",
            role: "admin",
            effective_role: "admin",
            viewer_mode: false,
          });
        }
        return Promise.resolve(progress());
      });

      act(() => {
        query("onboarding-checklist-dismiss")?.click();
      });
      await waitFor(() => {
        expect(mocks.apiPut).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(query("onboarding-checklist")).not.toBeNull();
        expect(query("onboarding-checklist-dismissed")).toBeNull();
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("never lets a client write done-ness", async () => {
    // Done-ness is derived from real rows by /onboarding-progress. Every write
    // this surface can make must be a decision, never a completion.
    serve({ steps: {} });
    const { root } = mount();
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist-dismiss")).not.toBeNull();
      });
      act(() => {
        query("onboarding-checklist-dismiss")?.click();
      });
      await waitFor(() => {
        expect(mocks.apiPut).toHaveBeenCalled();
      });
      for (const call of mocks.apiPut.mock.calls) {
        expect(call[0]).toBe(DECISIONS_PATH);
        expect(call[1]).not.toHaveProperty("completed");
        expect([
          "dismissed",
          "snoozed",
          "skipped",
          "inapplicable",
          "delegated",
        ]).toContain((call[1] as { state: string }).state);
      }
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("a control that cannot succeed is not offered", () => {
  it("hides the dismiss control from a viewer", async () => {
    // `PUT /api/v1/onboarding/steps` runs under `write:campaigns`, which the
    // session path denies to viewer. Offering the button would give a 403 and
    // an immediate rollback — a control that visibly does nothing.
    serve({ steps: {} });
    const { root } = mount("viewer");
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist")).not.toBeNull();
      });
      expect(query("onboarding-checklist-dismiss")).toBeNull();
      expect(mocks.apiPut).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("still honours a viewer's own decision recorded elsewhere", async () => {
    // Reading is a read scope, so a decision this person made from an
    // admin-capable session on another device must still be respected here.
    serve({
      steps: { [CHECKLIST_DECISION_STEP_KEY]: { state: "dismissed" } },
    });
    const { root } = mount("viewer");
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist-dismissed")).not.toBeNull();
      });
      expect(query("onboarding-checklist-restore")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("cache scoping", () => {
  it("keys decisions and progress per exact principal and viewer state", async () => {
    // A decision is one person's choice; sharing a cache entry with derived
    // tenant progress would leak it across a shared browser and force a
    // re-derivation of every EXISTS probe on every dismissal.
    serve({ steps: {} });
    const { queryClient, root } = mount();
    try {
      await waitFor(() => {
        expect(query("onboarding-checklist")).not.toBeNull();
      });
      const keys = queryClient
        .getQueryCache()
        .getAll()
        .map((entry) => entry.queryKey);
      const authority = onboardingAuthorityFromFields({
        tenantId: "tnt_1",
        userId: "usr_1",
        role: "admin",
        viewerMode: false,
      });
      expect(keys).toContainEqual(onboardingDecisionsKey(authority));
      expect(keys).toContainEqual(onboardingProgressKey(authority));
    } finally {
      act(() => root.unmount());
    }
  });
});
