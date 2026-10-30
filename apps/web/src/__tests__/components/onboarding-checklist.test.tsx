// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHECKLIST_GOALS,
  type OnboardingProgress,
} from "@postwave/onboarding-schema";

import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import {
  onboardingAuthorityFromFields,
  onboardingProgressKey,
} from "@/lib/onboarding-authority";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: mocks.apiGet } };
});

vi.mock("@/lib/telemetry", () => ({ track: mocks.track }));
vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));

const AUTHORITY = onboardingAuthorityFromFields({
  tenantId: "tnt_1",
  userId: "usr_1",
  role: "admin",
  viewerMode: false,
});

function checklist(overrides: Record<string, unknown> = {}): ReactNode {
  return createElement(OnboardingChecklist, {
    tenantId: "tnt_1",
    userId: "usr_1",
    role: "admin",
    viewerMode: false,
    ...overrides,
  });
}

function serveProgress(read: () => OnboardingProgress): void {
  mocks.apiGet.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/api/v1/onboarding/steps" ? { steps: {} } : read(),
    ),
  );
}

function progress(allDone: boolean): OnboardingProgress {
  return {
    steps: CHECKLIST_GOALS.map((goal) => ({
      key: goal.key,
      label: goal.label,
      description: goal.description,
      completed: allDone,
    })),
    completed: allDone ? CHECKLIST_GOALS.length : 0,
    total: CHECKLIST_GOALS.length,
    percent: allDone ? 100 : 0,
    all_done: allDone,
  };
}

function render(ui: ReactNode): {
  queryClient: QueryClient;
  root: Root;
} {
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

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  document.body.innerHTML = "";
});

describe("OnboardingChecklist", () => {
  it("uses a tenant-scoped key and sends bulk CSV users to the real importer", async () => {
    serveProgress(() => progress(false));
    const { queryClient, root } = render(checklist());

    try {
      await waitFor(() => {
        expect(
          document
            .querySelector('[data-goal-key="uploaded_subscribers_bulk"] a')
            ?.getAttribute("href"),
        ).toBe("/app/subscribers/import");
      });
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toContainEqual(onboardingProgressKey(AUTHORITY));
    } finally {
      act(() => root.unmount());
    }
  });

  it("celebrates only a persisted pending-to-done transition", async () => {
    let current = progress(false);
    serveProgress(() => current);
    const first = render(checklist());

    await waitFor(() => {
      expect(
        window.localStorage.getItem(
          `postwave:onboarding-completion:${encodeURIComponent(AUTHORITY.key)}`,
        ),
      ).toBe("pending");
    });
    current = progress(true);
    await act(async () => {
      await first.queryClient.refetchQueries({
        queryKey: onboardingProgressKey(AUTHORITY),
        exact: true,
      });
    });
    await waitFor(() => {
      expect(mocks.track).toHaveBeenCalledWith(
        "onboarding.checklist_completed",
        expect.objectContaining({ platform: "web" }),
      );
      expect(
        document.querySelector('[data-testid="onboarding-confetti"]'),
      ).not.toBeNull();
    });
    act(() => first.root.unmount());

    mocks.track.mockClear();
    const second = render(checklist());
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("You're all set");
      });
      expect(mocks.track).not.toHaveBeenCalledWith(
        "onboarding.checklist_completed",
        expect.anything(),
      );
      expect(
        document.querySelector('[data-testid="onboarding-confetti"]'),
      ).toBeNull();
    } finally {
      act(() => second.root.unmount());
    }
  });

  it("baselines already-complete tenants without replaying completion", async () => {
    serveProgress(() => progress(true));
    const { root } = render(
      checklist({
        tenantId: "tnt_existing",
        userId: "usr_existing",
        role: "owner",
      }),
    );
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("You're all set");
      });
      expect(mocks.track).not.toHaveBeenCalledWith(
        "onboarding.checklist_completed",
        expect.anything(),
      );
      expect(
        document.querySelector('[data-testid="onboarding-confetti"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
