// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";
import type { Approval } from "@/lib/approvals-api";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  getApproval: vi.fn(),
  rejectApproval: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
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
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));
vi.mock("@/lib/approvals-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/approvals-api")>()),
  getApproval: mocks.getApproval,
  rejectApproval: mocks.rejectApproval,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import { ApprovalDetailClient } from "@/app/(dashboard)/app/approvals/[id]/approval-detail-client";
import { ApprovalDecisionDialog } from "@/app/(dashboard)/app/approvals/approval-decision-dialog";
import { ApiError } from "@/lib/api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const approval: Approval = {
  id: "approval-1",
  tenantId: "tenant-1",
  resourceType: "campaign",
  resourceId: "campaign-1",
  requestedByActorLabel: "Ada",
  status: "pending",
  requestedAt: "2026-08-26T08:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
};

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "ada@example.test",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
    ...overrides,
  };
}

async function mount(): Promise<{
  client: QueryClient;
  container: HTMLElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ApprovalDetailClient id="approval-1" />
      </QueryClientProvider>,
    );
  });
  return { client, container, root };
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

async function eventually(assertion: () => void): Promise<void> {
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

function clickButton(name: string, occurrence = 0): void {
  const button = Array.from(document.querySelectorAll("button")).filter(
    (candidate) => candidate.textContent?.trim() === name,
  )[occurrence] as HTMLButtonElement | undefined;
  if (!button) throw new Error(`Button not found: ${name}`);
  button.click();
}

beforeEach(() => {
  mocks.whoami.mockReset();
  mocks.whoamiFresh.mockReset();
  mocks.getApproval.mockReset();
  mocks.rejectApproval.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.whoamiFresh.mockResolvedValue(me());
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("approval detail access and decision states", () => {
  it("makes zero detail requests for an effective viewer", async () => {
    mocks.whoami.mockResolvedValue(me({ effective_role: "viewer" }));
    const { container } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain(
        "Owner or admin access is required",
      ),
    );
    expect(mocks.getApproval).not.toHaveBeenCalled();
  });

  it("distinguishes a 404 from a request failure", async () => {
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval.mockRejectedValue(
      new ApiError("not found", 404, { error: "not found" }),
    );
    const { container } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("Approval not found"),
    );
    expect(container.textContent).not.toContain(
      "Approval details could not be loaded",
    );
  });

  it("requires a rejection reason before calling the API", async () => {
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval.mockResolvedValue(approval);
    const { container } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    await act(async () => {
      clickButton("Reject");
    });
    await act(async () => {
      clickButton("Reject", 1);
    });
    expect(document.body.textContent).toContain(
      "A rejection reason is required",
    );
    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.className).toContain("text-destructive-emphasis");
    expect(document.activeElement).toBe(alert);
    expect(mocks.rejectApproval).not.toHaveBeenCalled();
  });

  it("keys detail data to the exact principal and guards a verified rejection", async () => {
    const pending = deferred<{ ok: boolean }>();
    const rejected: Approval = {
      ...approval,
      status: "rejected",
      decidedAt: "2026-08-26T09:00:00Z",
      decidedByUserId: "user-1",
      notes: "Needs changes",
    };
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval
      .mockResolvedValueOnce(approval)
      .mockResolvedValueOnce(approval)
      .mockResolvedValue(rejected);
    mocks.rejectApproval.mockReturnValueOnce(pending.promise);

    const { client, container } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toContainEqual([
      "settings",
      "tenant-1",
      "admin",
      "approvals",
      "user-1",
      "member-mode",
      "detail",
      "approval-1",
    ]);
    expect(container.textContent).toContain(
      "Approval execution is on release hold",
    );
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Approve",
      ),
    ).toBe(false);

    const trigger = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Reject",
    );
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("Approval trigger not found");
    }
    await act(async () => trigger.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("Approval dialog not found");
    const submit = Array.from(dialog.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Reject",
    );
    const cancel = Array.from(dialog.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Cancel",
    );
    const close = Array.from(dialog.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Close",
    );
    if (!submit || !cancel || !close) {
      throw new Error("Approval dialog controls not found");
    }
    const textarea = dialog.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Rejection reason not found");
    }

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Needs changes");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      submit.click();
      cancel.click();
      submit.click();
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      );
    });
    await eventually(() =>
      expect(mocks.rejectApproval).toHaveBeenCalledTimes(1),
    );
    expect(mocks.whoamiFresh).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.rejectApproval).toHaveBeenCalledWith(
      "approval-1",
      "Needs changes",
      {
        idempotencyKey: expect.any(String),
        signal: expect.any(AbortSignal),
      },
    );
    await eventually(() => {
      expect(dialog.getAttribute("aria-busy")).toBe("true");
      expect((cancel as HTMLButtonElement).disabled).toBe(true);
      expect((close as HTMLButtonElement).disabled).toBe(true);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => pending.resolve({ ok: true }));
    await eventually(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    await eventually(() => {
      expect(document.activeElement?.textContent).toContain(
        "Back to approvals",
      );
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Rejection decision recorded.",
      {
        description:
          "Requester notification and downstream effects were not verified.",
      },
    );
  });

  it("acquires one synchronous lock across sibling rejection controls", async () => {
    const preflight = deferred<Approval>();
    mocks.getApproval.mockReturnValue(preflight.promise);
    const secondApproval: Approval = {
      ...approval,
      id: "approval-2",
      resourceId: "campaign-2",
    };
    const actionLock: { current: symbol | null } = { current: null };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ApprovalDecisionDialog
            approval={approval}
            kind="reject"
            identity={me()}
            authorityKey="tenant-1\u001fuser-1\u001fadmin\u001fmember-mode"
            protectedQueryKey={["settings", "tenant-1", "admin", "approvals"]}
            actionLock={actionLock}
            onAuthorityDenied={vi.fn()}
            onClose={vi.fn()}
            onReconciled={vi.fn()}
            onRecorded={vi.fn()}
          />
          <ApprovalDecisionDialog
            approval={secondApproval}
            kind="reject"
            identity={me()}
            authorityKey="tenant-1\u001fuser-1\u001fadmin\u001fmember-mode"
            protectedQueryKey={["settings", "tenant-1", "admin", "approvals"]}
            actionLock={actionLock}
            onAuthorityDenied={vi.fn()}
            onClose={vi.fn()}
            onReconciled={vi.fn()}
            onRecorded={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    const dialogs = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"]'),
    );
    expect(dialogs).toHaveLength(2);
    for (const dialog of dialogs) {
      const textarea = dialog.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement))
        throw new Error("No notes");
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set?.call(textarea, "Needs changes");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const submit = (dialog: HTMLElement): HTMLButtonElement => {
      const button = Array.from(dialog.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Reject",
      );
      if (!(button instanceof HTMLButtonElement)) throw new Error("No submit");
      return button;
    };

    await act(async () => submit(dialogs[0]!).click());
    await eventually(() => expect(mocks.getApproval).toHaveBeenCalledTimes(1));
    await act(async () => submit(dialogs[1]!).click());
    expect(dialogs[1]!.textContent).toContain(
      "Another approval action is already running",
    );
    expect(mocks.getApproval).toHaveBeenCalledTimes(1);
    expect(mocks.rejectApproval).not.toHaveBeenCalled();
  });

  it("sends nothing when the freshly read approval no longer matches", async () => {
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval
      .mockResolvedValueOnce(approval)
      .mockResolvedValueOnce({ ...approval, resourceId: "campaign-2" });
    const { container } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    await act(async () => clickButton("Reject"));
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("No notes");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Needs changes");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      clickButton("Reject", 1);
    });
    await eventually(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(container.textContent).toContain("campaign-2");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Approval changed. No rejection was sent.",
      expect.objectContaining({
        description: expect.stringContaining("changed"),
      }),
    );
    expect(mocks.whoamiFresh).not.toHaveBeenCalled();
    expect(mocks.rejectApproval).not.toHaveBeenCalled();
  });

  it("keeps a structured self-approval policy refusal local to the dialog", async () => {
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval.mockResolvedValue(approval);
    mocks.rejectApproval.mockRejectedValue(
      new ApiError(
        "the user who requested an approval cannot decide it",
        403,
        { error: "self approval" },
        {
          code: "self_approval",
          denial: {
            reason: "policy",
            code: "self_approval",
            subject: "approval",
          },
        },
      ),
    );
    const { client, container } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    await act(async () => clickButton("Reject"));
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("No notes");
    expect(document.body.textContent).toContain(
      "Do not include credentials, recipient data, or other secrets",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Needs changes");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      clickButton("Reject", 1);
    });
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "separation-of-duties policy prevents you from rejecting it",
      ),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain("campaign-1");
    expect(container.textContent).not.toContain("Approval access was denied");
    expect(
      client.getQueryData([
        "settings",
        "tenant-1",
        "admin",
        "approvals",
        "user-1",
        "member-mode",
        "detail",
        "approval-1",
      ]),
    ).toEqual(approval);
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ["auth-me"],
      exact: true,
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("reuses one individual intent key after an ambiguous rejection failure", async () => {
    const rejected: Approval = {
      ...approval,
      status: "rejected",
      decidedAt: "2026-08-26T09:00:00Z",
      decidedByUserId: "user-1",
      notes: "Needs changes",
    };
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval
      .mockResolvedValueOnce(approval)
      .mockResolvedValueOnce(approval)
      .mockResolvedValueOnce(approval)
      .mockResolvedValue(rejected);
    mocks.rejectApproval
      .mockRejectedValueOnce(new Error("network outcome unknown"))
      .mockResolvedValueOnce({ ok: true });
    const { container } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    await act(async () => clickButton("Reject"));
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("No notes");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Needs changes");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      clickButton("Reject", 1);
    });
    await eventually(() =>
      expect(document.body.textContent).toContain("network outcome unknown"),
    );
    const firstKey = mocks.rejectApproval.mock.calls[0]?.[2]?.idempotencyKey;
    expect(firstKey).toEqual(expect.any(String));
    await act(async () => clickButton("Reject", 1));
    await eventually(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(mocks.rejectApproval).toHaveBeenCalledTimes(2);
    expect(mocks.rejectApproval.mock.calls[1]?.[2]?.idempotencyKey).toBe(
      firstKey,
    );
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("purges protected data and sends nothing after a viewer-mode downgrade", async () => {
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval.mockResolvedValue(approval);
    mocks.whoamiFresh.mockResolvedValue(
      me({ effective_role: "viewer", viewer_mode: true }),
    );
    const { client, container } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    await act(async () => clickButton("Reject"));
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("No notes");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Needs changes");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      clickButton("Reject", 1);
    });
    await eventually(() =>
      expect(container.textContent).toContain(
        "Owner or admin access is required",
      ),
    );
    expect(mocks.rejectApproval).not.toHaveBeenCalled();
    expect(
      client.getQueryData([
        "settings",
        "tenant-1",
        "admin",
        "approvals",
        "user-1",
        "member-mode",
        "detail",
        "approval-1",
      ]),
    ).toBeUndefined();
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey.includes("approvals"))
        .every((query) => query.state.data === undefined),
    ).toBe(true);
  });

  it("aborts an in-flight exact preflight and contains late completion after unmount", async () => {
    const preflight = deferred<Approval>();
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval
      .mockResolvedValueOnce(approval)
      .mockReturnValueOnce(preflight.promise);
    const { container, root } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    await act(async () => clickButton("Reject"));
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("No notes");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Needs changes");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      clickButton("Reject", 1);
    });
    await eventually(() => expect(mocks.getApproval).toHaveBeenCalledTimes(2));
    const signal = mocks.getApproval.mock.calls[1]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);

    roots.splice(roots.indexOf(root), 1);
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    await act(async () => preflight.resolve(approval));
    expect(mocks.whoamiFresh).not.toHaveBeenCalled();
    expect(mocks.rejectApproval).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("aborts an in-flight rejection mutation and contains its late completion", async () => {
    const mutation = deferred<{ ok: boolean }>();
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval.mockResolvedValue(approval);
    mocks.rejectApproval.mockReturnValueOnce(mutation.promise);
    const { container, root } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    await act(async () => clickButton("Reject"));
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("No notes");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Needs changes");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      clickButton("Reject", 1);
    });
    await eventually(() => expect(mocks.rejectApproval).toHaveBeenCalledOnce());
    const signal = mocks.rejectApproval.mock.calls[0]?.[2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);

    roots.splice(roots.indexOf(root), 1);
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    await act(async () => mutation.resolve({ ok: true }));
    expect(mocks.getApproval).toHaveBeenCalledTimes(2);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("aborts an in-flight rejection readback and contains its late success", async () => {
    const readback = deferred<Approval>();
    const rejected: Approval = {
      ...approval,
      status: "rejected",
      decidedAt: "2026-08-26T09:00:00Z",
      decidedByUserId: "user-1",
      notes: "Needs changes",
    };
    mocks.whoami.mockResolvedValue(me());
    mocks.getApproval
      .mockResolvedValueOnce(approval)
      .mockResolvedValueOnce(approval)
      .mockReturnValueOnce(readback.promise);
    mocks.rejectApproval.mockResolvedValue({ ok: true });
    const { container, root } = await mount();
    await eventually(() =>
      expect(container.textContent).toContain("campaign-1"),
    );
    await act(async () => clickButton("Reject"));
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("No notes");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "Needs changes");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      clickButton("Reject", 1);
    });
    await eventually(() => expect(mocks.getApproval).toHaveBeenCalledTimes(3));
    const signal = mocks.getApproval.mock.calls[2]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(mocks.rejectApproval.mock.calls[0]?.[2]?.signal).toBe(signal);

    roots.splice(roots.indexOf(root), 1);
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    await act(async () => readback.resolve(rejected));
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
