// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SubmissionsPage from "@/app/(dashboard)/app/forms/[id]/submissions/page";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const FORM_ID = "form-focus";
const SUBMISSION_ID = "submission-focus";

const mocks = vi.hoisted(() => ({
  deleteSubmission: vi.fn(),
  fetchSubmissionsCsv: vi.fn(),
  getForm: vi.fn(),
  listAllSubmissions: vi.fn(),
  resendConfirmation: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: FORM_ID }),
  usePathname: () => `/app/forms/${FORM_ID}/submissions`,
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => createElement("a", { href, ...props }, children),
}));

vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (identity: { effective_role?: string; role: string }) =>
    identity.effective_role ?? identity.role,
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/forms-api", () => ({
  deleteSubmission: mocks.deleteSubmission,
  fetchSubmissionsCsv: mocks.fetchSubmissionsCsv,
  getForm: mocks.getForm,
  listAllSubmissions: mocks.listAllSubmissions,
  resendConfirmation: mocks.resendConfirmation,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

const form = {
  id: FORM_ID,
  tenantId: "tenant-focus",
  slug: "focus-form",
  name: "Focus form",
  optInMode: "double",
  structure: { fields: [] },
  settings: { successMessage: "Thanks" },
  status: "published",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

const submission = {
  id: SUBMISSION_ID,
  formId: FORM_ID,
  email: "reader@example.test",
  customFields: {},
  status: "pending",
  ip: "203.0.113.8",
  userAgent: "Focus regression",
  submittedAt: "2026-08-01T00:00:00Z",
  confirmedAt: null,
};

let root: Root | null = null;
let submissions = [submission];

beforeEach(() => {
  submissions = [submission];
  const identity = {
    user_id: "user-focus",
    tenant_id: "tenant-focus",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  };
  mocks.whoami.mockResolvedValue(identity);
  mocks.whoamiFresh.mockResolvedValue(identity);
  mocks.getForm.mockResolvedValue(form);
  mocks.listAllSubmissions.mockImplementation(async () => ({
    items: [...submissions],
    truncated: false,
  }));
  mocks.deleteSubmission.mockImplementation(async () => {
    submissions = [];
    return { ok: true };
  });
  mocks.resendConfirmation.mockResolvedValue({ ok: true });
  mocks.fetchSubmissionsCsv.mockResolvedValue("id,email\n");
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  });
}

async function renderPage(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SubmissionsPage),
      ),
    );
  });
  for (let turn = 0; turn < 12; turn += 1) {
    await settle();
    if (actionsTrigger()) return;
  }
  throw new Error("Submission actions did not load");
}

function actionsTrigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    'button[aria-label="Actions for reader@example.test"]',
  );
}

function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

async function openDeleteDialog(): Promise<HTMLElement> {
  const trigger = actionsTrigger();
  if (!trigger) throw new Error("Missing submission actions trigger");
  await act(async () => trigger.click());
  await act(async () => button("Delete").click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Delete dialog did not open");
  return dialog;
}

describe("submission delete dialog focus", () => {
  it("stacks intrinsic-width date controls until their filter row has room", async () => {
    await renderPage();
    const from = document.querySelector<HTMLInputElement>("#sub-from");
    const to = document.querySelector<HTMLInputElement>("#sub-to");
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    expect(from?.classList.contains("min-w-0")).toBe(true);
    expect(to?.classList.contains("min-w-0")).toBe(true);
    expect(from?.parentElement?.classList.contains("min-w-0")).toBe(true);
    expect(to?.parentElement?.classList.contains("min-w-0")).toBe(true);

    const dateFilters = from?.parentElement?.parentElement;
    expect(dateFilters?.classList.contains("grid-cols-1")).toBe(true);
    expect(dateFilters?.classList.contains("sm:col-span-2")).toBe(true);
    expect(dateFilters?.classList.contains("sm:grid-cols-2")).toBe(true);
    expect(dateFilters?.classList.contains("xl:col-span-2")).toBe(true);
  });

  it("returns Escape focus to the exact row action trigger", async () => {
    await renderPage();
    const trigger = actionsTrigger();
    expect(trigger).not.toBeNull();
    await openDeleteDialog();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    await settle();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps pending deletion atomic and safely removes its trigger on success", async () => {
    let resolveDelete: (() => void) | undefined;
    mocks.deleteSubmission.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveDelete = () => {
            submissions = [];
            resolve({ ok: true });
          };
        }),
    );
    await renderPage();
    const dialog = await openDeleteDialog();

    await act(async () => {
      button("Delete", dialog).click();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(mocks.deleteSubmission).toHaveBeenCalledTimes(1);

    await act(async () => resolveDelete?.());
    await settle();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(actionsTrigger()).toBeNull();
  });
});
