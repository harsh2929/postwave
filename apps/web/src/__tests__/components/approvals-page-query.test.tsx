// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import ApprovalsPage from "@/app/(dashboard)/app/approvals/page";
import { CommandRegistryProvider } from "@/components/command-registry";
import { ApiError } from "@/lib/api";
import { ApprovalContractError, type Approval } from "@/lib/approvals-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listApprovals: vi.fn(),
  getApproval: vi.fn(),
  rejectApproval: vi.fn(),
  listDelegations: vi.fn(),
  getEscalationPolicy: vi.fn(),
  navigationSearch: "",
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mocks.routerReplace,
    push: mocks.routerPush,
    back: vi.fn(),
  }),
  usePathname: () => "/app/approvals",
  useSearchParams: () => new URLSearchParams(mocks.navigationSearch),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string | { pathname?: string };
  } & Record<string, unknown>) =>
    createElement(
      "a",
      { href: typeof href === "string" ? href : "#", ...props },
      children,
    ),
}));

vi.mock("@/lib/approvals-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/approvals-api")>();
  return {
    ...actual,
    listApprovals: mocks.listApprovals,
    getApproval: mocks.getApproval,
    rejectApproval: mocks.rejectApproval,
    listDelegations: mocks.listDelegations,
    getEscalationPolicy: mocks.getEscalationPolicy,
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

// happy-dom does not reliably hydrate a Next `{ ssr: false }` boundary that
// first mounts after an interaction. Exercise the real deferred approval
// components so this suite continues to cover decision and governance wiring,
// while production keeps both boundaries lazy.
vi.mock("next/dynamic", async () => {
  const [{ ApprovalDecisionDialog }, { ApprovalsGovernancePanel }] =
    await Promise.all([
      import("@/app/(dashboard)/app/approvals/approval-decision-dialog"),
      import("@/app/(dashboard)/app/approvals/approvals-governance-panel"),
    ]);
  const deferredComponents = [ApprovalDecisionDialog, ApprovalsGovernancePanel];
  let nextBoundary = 0;

  return {
    default: () => {
      const DeferredComponent = deferredComponents[nextBoundary];
      nextBoundary += 1;
      return DeferredComponent ?? (() => null);
    },
  };
});

const pendingApproval: Approval = {
  id: "appr_1",
  tenantId: "tnt_1",
  resourceType: "campaign",
  resourceId: "cmp_1",
  requestedByActorLabel: "Ada",
  status: "pending",
  requestedAt: "2026-06-27T12:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00Z",
};

afterEach(() => {
  vi.resetAllMocks();
  mocks.navigationSearch = "";
  document.body.innerHTML = "";
});

function render(ui: ReactNode): { queryClient: QueryClient; root: Root } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(CommandRegistryProvider, null, ui),
      ),
    );
  });
  return { queryClient, root };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function findButton(name: string, occurrence = 0): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === name,
  );
  const button = buttons[occurrence];
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function clickTab(label: string): void {
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) =>
    el.textContent?.trim().startsWith(label),
  ) as HTMLElement | undefined;
  if (!tab) throw new Error(`Tab not found: ${label}`);
  // Radix Tabs selects on mousedown (not a bare click).
  tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  tab.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

function primeAuth() {
  const identity = {
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "ada@example.com",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  } as const;
  mocks.whoami.mockResolvedValue(identity);
  mocks.whoamiFresh.mockResolvedValue(identity);
  mocks.listDelegations.mockResolvedValue([]);
  mocks.getEscalationPolicy.mockResolvedValue({
    escalateAfterHours: null,
    notifyOwners: false,
  });
  return identity;
}

describe("ApprovalsPage query freshness", () => {
  it("labels unresolved access and makes no protected requests while auth is pending", async () => {
    const auth = deferred<Record<string, never>>();
    mocks.whoami.mockReturnValue(auth.promise);

    const { root } = render(createElement(ApprovalsPage));
    try {
      await waitFor(() => {
        expect(
          document.querySelector(
            '[role="status"][aria-label="Verifying approval access"]',
          ),
        ).not.toBeNull();
      });
      expect(mocks.listApprovals).not.toHaveBeenCalled();
      expect(mocks.listDelegations).not.toHaveBeenCalled();
      expect(mocks.getEscalationPolicy).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("makes zero approval or governance requests for an effective viewer", async () => {
    primeAuth();
    mocks.whoami.mockResolvedValue({
      user_id: "usr_1",
      tenant_id: "tnt_1",
      email: "ada@example.com",
      role: "admin",
      effective_role: "viewer",
      viewer_mode: true,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Acme",
      workspace_slug: "acme",
    });

    const { root } = render(createElement(ApprovalsPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Owner or admin access is required",
        );
      });
      expect(mocks.listApprovals).not.toHaveBeenCalled();
      expect(mocks.listDelegations).not.toHaveBeenCalled();
      expect(mocks.getEscalationPolicy).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("loads all approvals once and filters tabs client-side", async () => {
    primeAuth();
    mocks.listApprovals.mockResolvedValue([
      pendingApproval,
      {
        ...pendingApproval,
        id: "appr_2",
        resourceId: "cmp_2",
        status: "approved",
      },
    ]);

    const { root } = render(createElement(ApprovalsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("cmp_1");
      });
      // One high-limit fetch backs every tab; no per-filter round-trips.
      expect(mocks.listApprovals).toHaveBeenCalledWith("all", 200, {
        expectedTenantId: "tnt_1",
        signal: expect.any(AbortSignal),
      });
      // Pending tab hides the approved row.
      expect(document.body.textContent).not.toContain("cmp_2");

      await act(async () => {
        clickTab("Approved");
        await flush();
      });

      await waitFor(() => {
        expect(document.body.textContent).toContain("cmp_2");
      });
      expect(mocks.routerPush).toHaveBeenCalledWith(
        "/app/approvals?status=approved",
        { scroll: false },
      );
      // Tab switch is client-side — still a single fetch.
      expect(mocks.listApprovals).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("synchronizes status and focus when browser history changes the query", async () => {
    primeAuth();
    mocks.navigationSearch = "focus=appr_2";
    mocks.listApprovals.mockResolvedValue([
      pendingApproval,
      {
        ...pendingApproval,
        id: "appr_2",
        resourceId: "cmp_2",
        status: "approved",
      },
    ]);

    const { queryClient, root } = render(createElement(ApprovalsPage));
    const rerender = (): void => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            CommandRegistryProvider,
            null,
            createElement(ApprovalsPage),
          ),
        ),
      );
    };

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("cmp_2");
        expect(
          document.querySelector('[role="tab"][aria-selected="true"]')
            ?.textContent,
        ).toContain("All");
        expect(
          document.querySelector('[data-focus-target="true"]')?.textContent,
        ).toContain("cmp_2");
      });

      mocks.navigationSearch = "status=pending";
      await act(async () => {
        rerender();
        await flush();
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain("cmp_1");
        expect(document.body.textContent).not.toContain("cmp_2");
        expect(
          document.querySelector('[role="tab"][aria-selected="true"]')
            ?.textContent,
        ).toContain("Pending");
        expect(document.querySelector('[data-focus-target="true"]')).toBeNull();
      });

      mocks.navigationSearch = "status=approved";
      await act(async () => {
        rerender();
        await flush();
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain("cmp_2");
        expect(document.body.textContent).not.toContain("cmp_1");
      });
      expect(mocks.routerReplace).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("canonicalizes an unsupported status without dropping a focus deep-link", async () => {
    primeAuth();
    mocks.navigationSearch = "status=unknown&focus=appr_1";
    mocks.listApprovals.mockResolvedValue([pendingApproval]);

    const { root } = render(createElement(ApprovalsPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("cmp_1");
        expect(
          document.querySelector('[role="tab"][aria-selected="true"]')
            ?.textContent,
        ).toContain("All");
      });
      expect(mocks.routerReplace).toHaveBeenCalledWith(
        "/app/approvals?focus=appr_1",
        { scroll: false },
      );
      await act(async () => {
        clickTab("Pending");
        await flush();
      });
      expect(mocks.routerPush).toHaveBeenCalledWith(
        "/app/approvals?status=pending&focus=appr_1",
        { scroll: false },
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the admin-access message for 403 list failures", async () => {
    primeAuth();
    mocks.listApprovals.mockRejectedValueOnce(
      new ApiError("forbidden", 403, { error: "forbidden" }),
    );

    const { root } = render(createElement(ApprovalsPage));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Approval access was denied",
        );
      });
      // A 403 must not read as an empty queue: the failure branch replaces the
      // "Nothing to review" empty state rather than sitting beside it.
      expect(document.body.textContent).not.toContain("Nothing to review");
      expect(document.body.textContent).toContain(
        "Cached approval data was cleared",
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("purges the queue when a response crosses the expected tenant boundary", async () => {
    primeAuth();
    mocks.listApprovals.mockRejectedValueOnce(
      new ApprovalContractError("foreign-tenant", 0),
    );

    const { queryClient, root } = render(createElement(ApprovalsPage));
    queryClient.setQueryData(
      [
        "settings",
        "old-tenant",
        "admin",
        "approvals",
        "usr_old",
        "member-mode",
      ],
      [pendingApproval],
    );
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Approval access was denied",
        ),
      );
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey.includes("approvals"))
          .every((query) => query.state.data === undefined),
      ).toBe(true);
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Reject",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("clears stale rows and controls when a background refresh is denied", async () => {
    primeAuth();
    mocks.listApprovals
      .mockResolvedValueOnce([pendingApproval])
      .mockRejectedValueOnce(
        new ApiError("forbidden", 403, { error: "forbidden" }),
      );
    const { root } = render(createElement(ApprovalsPage));
    try {
      await waitFor(() => expect(document.body.textContent).toContain("cmp_1"));
      await act(async () => findButton("Refresh").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Approval access was denied",
        ),
      );
      expect(document.body.textContent).not.toContain("cmp_1");
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Reject",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("revalidates identity before a denied queue can be requested again", async () => {
    const identity = primeAuth();
    const refreshedIdentity = deferred<typeof identity>();
    mocks.whoami
      .mockReset()
      .mockResolvedValueOnce(identity)
      .mockReturnValue(refreshedIdentity.promise);
    mocks.listApprovals
      .mockRejectedValueOnce(
        new ApiError("forbidden", 403, { error: "forbidden" }),
      )
      .mockResolvedValue([pendingApproval]);

    const { root } = render(createElement(ApprovalsPage));
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Approval access was denied",
        ),
      );
      expect(findButton("Try again").disabled).toBe(true);
      expect(mocks.listApprovals).toHaveBeenCalledTimes(1);

      await act(async () => refreshedIdentity.resolve(identity));
      await waitFor(() => expect(findButton("Try again").disabled).toBe(false));
      await act(async () => findButton("Try again").click());
      await waitFor(() => expect(mocks.listApprovals).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(document.body.textContent).toContain("cmp_1"));
    } finally {
      act(() => root.unmount());
    }
  });

  it("exposes rejection only and keeps unsafe governance transport dormant", async () => {
    primeAuth();
    mocks.listApprovals.mockResolvedValue([pendingApproval]);

    const { root } = render(createElement(ApprovalsPage));
    try {
      await waitFor(() => expect(document.body.textContent).toContain("cmp_1"));
      expect(document.body.textContent).toContain(
        "Approval execution is on release hold",
      );
      expect(document.body.textContent).toContain(
        "Approval governance is on release hold",
      );
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Approve",
        ),
      ).toBe(false);
      expect(findButton("Reject")).toBeDefined();
      expect(
        document.querySelector('input[aria-label^="Select campaign"]'),
      ).toBeNull();
      expect(document.body.textContent).not.toContain("Select all pending");
      expect(document.body.textContent).not.toContain("Approve next");
      expect(mocks.listDelegations).not.toHaveBeenCalled();
      expect(mocks.getEscalationPolicy).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("records rejection only after exact preflight, fresh authority, and readback", async () => {
    primeAuth();
    const rejected: Approval = {
      ...pendingApproval,
      status: "rejected",
      decidedAt: "2026-06-27T12:05:00.000Z",
      decidedByUserId: "usr_1",
      notes: "Needs changes",
    };
    mocks.listApprovals.mockResolvedValue([pendingApproval]);
    mocks.getApproval
      .mockResolvedValueOnce(pendingApproval)
      .mockResolvedValue(rejected);
    mocks.rejectApproval.mockResolvedValue({ ok: true });

    const { queryClient, root } = render(createElement(ApprovalsPage));
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    try {
      await waitFor(() => expect(document.body.textContent).toContain("cmp_1"));
      await act(async () => findButton("Reject").click());
      const textarea = document.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("Rejection reason not found");
      }
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(textarea, "Needs changes");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        findButton("Reject", 1).click();
      });

      await waitFor(() =>
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          "Rejection decision recorded.",
          {
            description:
              "Requester notification and downstream effects were not verified.",
          },
        ),
      );
      expect(mocks.getApproval).toHaveBeenNthCalledWith(1, "appr_1", {
        expectedTenantId: "tnt_1",
        signal: expect.any(AbortSignal),
      });
      expect(mocks.whoamiFresh).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(mocks.rejectApproval).toHaveBeenCalledWith(
        "appr_1",
        "Needs changes",
        {
          idempotencyKey: expect.any(String),
          signal: expect.any(AbortSignal),
        },
      );
      expect(mocks.getApproval).toHaveBeenNthCalledWith(2, "appr_1", {
        expectedTenantId: "tnt_1",
        signal: expect.any(AbortSignal),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: [
          "settings",
          "tnt_1",
          "admin",
          "approvals",
          "usr_1",
          "member-mode",
        ],
        exact: false,
      });
      expect(invalidateSpy).not.toHaveBeenCalledWith({
        queryKey: ["campaigns", "tnt_1", "admin"],
        exact: false,
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("sends nothing when an exact preflight field changed", async () => {
    primeAuth();
    mocks.listApprovals.mockResolvedValue([pendingApproval]);
    mocks.getApproval.mockResolvedValue({
      ...pendingApproval,
      requestedAt: "2026-06-27T12:01:00.000Z",
    });

    const { queryClient, root } = render(createElement(ApprovalsPage));
    try {
      await waitFor(() => expect(document.body.textContent).toContain("cmp_1"));
      await act(async () => findButton("Reject").click());
      const textarea = document.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("No notes");
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(textarea, "Needs changes");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        findButton("Reject", 1).click();
      });
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Approval changed. No rejection was sent.",
        expect.objectContaining({
          description: expect.stringContaining("record changed"),
        }),
      );
      expect(
        queryClient.getQueryData<Approval[]>([
          "settings",
          "tnt_1",
          "admin",
          "approvals",
          "usr_1",
          "member-mode",
        ])?.[0]?.requestedAt,
      ).toBe("2026-06-27T12:01:00.000Z");
      expect(mocks.whoamiFresh).not.toHaveBeenCalled();
      expect(mocks.rejectApproval).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("purges another principal's cached approval rows for viewer mode", async () => {
    primeAuth();
    mocks.whoami.mockResolvedValue({
      user_id: "usr_2",
      tenant_id: "tnt_1",
      email: "viewer@example.com",
      role: "admin",
      effective_role: "viewer",
      viewer_mode: true,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Acme",
      workspace_slug: "acme",
    });

    const { queryClient, root } = render(createElement(ApprovalsPage));
    queryClient.setQueryData(
      ["settings", "tnt_1", "admin", "approvals", "usr_1", "member-mode"],
      [pendingApproval],
    );
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Owner or admin access is required",
        ),
      );
      await waitFor(() =>
        expect(
          queryClient.getQueryData([
            "settings",
            "tnt_1",
            "admin",
            "approvals",
            "usr_1",
            "member-mode",
          ]),
        ).toBeUndefined(),
      );
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey.includes("approvals"))
          .every((query) => query.state.data === undefined),
      ).toBe(true);
      expect(mocks.listApprovals).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
