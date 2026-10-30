// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// What the Submissions page tells the operator about consent and the double
// opt-in email: a response whose consent box was left unticked is a
// "response only", never counted as confirmed, and a pending submission whose
// confirmation email did not reach the visitor says so, with what to do.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SubmissionsPage from "@/app/(dashboard)/app/forms/[id]/submissions/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  deleteSubmission: vi.fn(),
  fetchSubmissionsCsv: vi.fn(),
  getForm: vi.fn(),
  listAllSubmissions: vi.fn(),
  resendConfirmation: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "form-1" }),
  usePathname: () => "/app/forms/form-1/submissions",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
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

vi.mock("@/lib/download", () => ({ downloadTextFile: vi.fn() }));

const form = {
  id: "form-1",
  tenantId: "tenant-1",
  slug: "newsletter",
  name: "Newsletter",
  optInMode: "double",
  structure: { fields: [] },
  settings: { successMessage: "Thanks" },
  status: "published",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

function identity(role: "owner" | "admin" | "editor" | "viewer") {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "user@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
  };
}

let root: Root | null = null;

async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPage() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SubmissionsPage),
      ),
    );
  });
  await settle();
  return { host, queryClient };
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue(identity("owner"));
  mocks.whoamiFresh.mockResolvedValue(identity("owner"));
  mocks.getForm.mockResolvedValue(form);
  const base = { formId: "form-1", customFields: {}, submittedAt: "2026-08-01T00:00:00Z", ip: null, userAgent: null, confirmedAt: null };
  mocks.listAllSubmissions.mockResolvedValue({
    items: [
      { ...base, id: "s-confirmed", email: "joined@example.test", status: "confirmed" },
      { ...base, id: "s-received", email: "reader@example.test", status: "received" },
      { ...base, id: "s-failed", email: "failed@example.test", status: "pending", confirmationEmail: "send_failed" },
      { ...base, id: "s-nosender", email: "nosender@example.test", status: "pending", confirmationEmail: "no_sender" },
      { ...base, id: "s-sent", email: "waiting@example.test", status: "pending", confirmationEmail: "sent" },
    ],
    truncated: false,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function rowOf(host: HTMLElement, email: string): HTMLTableRowElement {
  const link = Array.from(host.querySelectorAll("a")).find((a) => a.textContent === email);
  const row = link?.closest("tr");
  if (!row) throw new Error(`no row for ${email}`);
  return row;
}

describe("form submissions: consent and confirmation email", () => {
  it("counts a response without consent apart from confirmed signups", async () => {
    const { host } = await renderPage();
    const summary = host.querySelector("h1")?.parentElement?.querySelector("p")?.textContent ?? "";
    expect(summary).toContain("5 total · 1 confirmed · 3 pending · 1 response without consent");
    expect(rowOf(host, "reader@example.test").textContent).toContain("response only");
    const filter = host.querySelector<HTMLSelectElement>("#sub-status");
    expect(Array.from(filter?.options ?? []).map((o) => o.textContent)).toContain("Response only (no consent)");
  });

  it("says when a confirmation email did not reach the visitor, and what to do", async () => {
    const { host } = await renderPage();
    expect(rowOf(host, "failed@example.test").textContent).toContain(
      "Confirmation email not delivered. It's retried automatically, or you can resend it.",
    );
    expect(rowOf(host, "nosender@example.test").textContent).toContain(
      "Set a sender address on a verified domain in the form's settings, then resend.",
    );
    expect(rowOf(host, "waiting@example.test").textContent).not.toContain("Confirmation email");
  });
});
