// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "../pages/_harness";

const apiMocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  getJob: vi.fn(),
  createJob: vi.fn(),
  jobResults: vi.fn(),
  cancelJob: vi.fn(),
}));
const authorityMocks = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("@/lib/verification-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verification-api")>()),
  listVerificationJobs: apiMocks.listJobs,
  getVerificationJob: apiMocks.getJob,
  createVerificationJob: apiMocks.createJob,
  listVerificationJobResults: apiMocks.jobResults,
  cancelVerificationJob: apiMocks.cancelJob,
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: authorityMocks.verify,
}));

const KEY_BASE = ["verification", WHOAMI.tenant_id, "owner"] as const;

const JOB = {
  id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
  status: "running" as const,
  source: "inline" as const,
  execution_mode: "full" as const,
  total: 10,
  processed: 3,
  cache_hits: 1,
  local_filtered: 1,
  vendor_verified: 1,
  credits_spent: 1,
  duplicates: 0,
  ambiguous: 0,
  attempts: 1,
  has_error: false,
  created_at: "2026-08-29T00:00:00Z",
  started_at: "2026-08-29T00:00:01Z",
};
const NEW_JOB = {
  ...JOB,
  id: "018f47f2-9f25-7f73-8ec6-3fd483eb51ee",
  status: "pending" as const,
  source: "tag" as const,
  total: 42,
  processed: 0,
  cache_hits: 0,
  local_filtered: 0,
  vendor_verified: 0,
  credits_spent: 0,
  attempts: 0,
  created_at: "2026-08-29T00:05:00Z",
  started_at: undefined,
};
const DONE_JOB = {
  ...JOB,
  id: "018f47f2-9f25-7f73-8ec6-3fd483eb51df",
  status: "completed" as const,
  total: 3,
  processed: 3,
  completed_at: "2026-08-29T00:00:09Z",
};
const DONE_DETAIL = {
  job: DONE_JOB,
  summary: { valid: 1, invalid: 2 },
  credits_saved: 2,
  credits_spent: 1,
  is_terminal: true,
};

function processed(email: string, status: "valid" | "invalid", extra = {}) {
  return {
    email,
    processed: true,
    status,
    billable: false,
    cached: true,
    checked_at: "2026-08-29T00:00:02Z",
    attempt_state: "succeeded" as const,
    ...extra,
  };
}
const A_VALID = processed("a@example.test", "valid");
const B_INVALID = processed("b@example.test", "invalid", {
  sub_status: "mailbox_not_found",
});
const C_INVALID = processed("c@example.test", "invalid");
const D_INVALID = processed("d@example.test", "invalid");

function page(rows: object[], offset: number, hasMore: boolean) {
  return { results: rows, offset, page_size: 100, has_more: hasMore };
}

async function settle(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(scope: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function type(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  authorityMocks.verify.mockReset();
  authorityMocks.verify.mockResolvedValue(WHOAMI);
  apiMocks.listJobs.mockResolvedValue([JOB]);
  apiMocks.getJob.mockImplementation(async (id: string) =>
    id === DONE_JOB.id
      ? DONE_DETAIL
      : {
          job: id === NEW_JOB.id ? NEW_JOB : JOB,
          summary: id === NEW_JOB.id ? {} : { valid: 2, unknown: 1 },
          credits_saved: id === NEW_JOB.id ? 0 : 2,
          credits_spent: id === NEW_JOB.id ? 0 : 1,
          is_terminal: false,
        },
  );
  apiMocks.jobResults.mockImplementation(
    async (_id: string, options?: { status?: string; offset?: number }) => {
      const status = options?.status || "";
      const offset = options?.offset ?? 0;
      if (!status && offset === 0)
        return page([A_VALID, B_INVALID, C_INVALID], 0, true);
      if (status === "invalid" && offset === 0)
        return page([B_INVALID, C_INVALID], 0, true);
      if (status === "invalid" && offset === 100)
        return page([D_INVALID], 100, false);
      return page([], offset, false);
    },
  );
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("verification jobs panel", () => {
  it("refreshes stale job history when its detail reaches a terminal receipt", async () => {
    const { VerificationJobsPanel } =
      await import("@/app/(dashboard)/app/verification/verification-jobs-panel");
    apiMocks.listJobs.mockResolvedValueOnce([
      { ...DONE_JOB, status: "pending", processed: 0 },
    ]);
    apiMocks.listJobs.mockResolvedValue([DONE_JOB]);
    const { container, root } = await renderPage(VerificationJobsPanel, {
      identity: WHOAMI,
      queryKeyBase: KEY_BASE,
    });
    try {
      const row = container.querySelector<HTMLButtonElement>(
        'ul[aria-label="Verification jobs"] button',
      );
      expect(row?.textContent).toContain("pending");
      await act(async () => {
        row?.click();
      });
      await settle();
      expect(apiMocks.listJobs).toHaveBeenCalledTimes(2);
      expect(row?.textContent).toContain("completed");
      expect(row?.textContent).toContain("3 / 3 processed");
      expect(row?.textContent).not.toContain("pending");
    } finally {
      unmount(root);
    }
  });

  it("starts a tag-scoped run through a confirm that names the credit consequence", async () => {
    const { VerificationJobsPanel } =
      await import("@/app/(dashboard)/app/verification/verification-jobs-panel");
    const { container, root } = await renderPage(VerificationJobsPanel, {
      identity: WHOAMI,
      queryKeyBase: KEY_BASE,
    });
    try {
      const sourceSelect =
        container.querySelector<HTMLSelectElement>("#v-run-source");
      expect(sourceSelect).not.toBeNull();
      expect([...(sourceSelect?.options ?? [])].map((o) => o.value)).toEqual([
        "inline",
        "tag",
        "all_subscribers",
      ]);
      const start = button(container, "Start verification run");
      expect(start?.disabled).toBe(true);

      await act(async () => {
        if (sourceSelect) choose(sourceSelect, "tag");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const tagInput = container.querySelector<HTMLInputElement>("#v-run-tag");
      expect(tagInput).not.toBeNull();
      await act(async () => {
        if (tagInput) type(tagInput, " vip ");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(start?.disabled).toBe(false);

      await act(async () => {
        start?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.textContent).toContain("Start verification run?");
      expect(document.body.textContent).toContain('tagged "vip"');
      expect(document.body.textContent).toContain(
        "One provider credit can be spent per address",
      );
      expect(apiMocks.createJob).not.toHaveBeenCalled();

      apiMocks.createJob.mockResolvedValue(NEW_JOB);
      apiMocks.listJobs.mockResolvedValue([NEW_JOB, JOB]);
      const confirm = button(document.body, "Start run");
      expect(confirm).not.toBeNull();
      await act(async () => {
        confirm?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();

      expect(authorityMocks.verify).toHaveBeenCalledTimes(1);
      expect(apiMocks.createJob).toHaveBeenCalledTimes(1);
      const [input, key, signal] = apiMocks.createJob.mock.calls[0] ?? [];
      expect(input).toEqual({ source: "tag", source_ref: "vip" });
      expect(typeof key).toBe("string");
      expect((key as string).length).toBeGreaterThan(0);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(container.textContent).toContain(
        `Run ${NEW_JOB.id} was accepted as pending with 42 addresses`,
      );
      const selected = container.querySelector('button[aria-pressed="true"]');
      expect(selected?.textContent).toContain(NEW_JOB.id);
    } finally {
      unmount(root);
    }
  });

  it("withholds run creation from a viewer and says why", async () => {
    const { VerificationJobsPanel } =
      await import("@/app/(dashboard)/app/verification/verification-jobs-panel");
    const { container, root } = await renderPage(VerificationJobsPanel, {
      identity: { ...WHOAMI, role: "viewer", effective_role: "viewer" },
      queryKeyBase: ["verification", WHOAMI.tenant_id, "viewer"],
    });
    try {
      expect(container.querySelector("#v-run-source")).toBeNull();
      expect(button(container, "Start verification run")).toBeNull();
      expect(container.textContent).toContain(
        "Owner or admin access outside viewer mode is required to start a run",
      );
      expect(apiMocks.createJob).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("browses per-address results with a status filter and offset paging", async () => {
    apiMocks.listJobs.mockResolvedValue([DONE_JOB]);
    const { VerificationJobsPanel } =
      await import("@/app/(dashboard)/app/verification/verification-jobs-panel");
    const { container, root } = await renderPage(VerificationJobsPanel, {
      identity: WHOAMI,
      queryKeyBase: KEY_BASE,
    });
    try {
      const jobButton = [
        ...container.querySelectorAll<HTMLButtonElement>(
          'ul[aria-label="Verification jobs"] button',
        ),
      ].find((candidate) => candidate.textContent?.includes(DONE_JOB.id));
      expect(jobButton).not.toBeUndefined();
      await act(async () => {
        jobButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();

      expect(apiMocks.jobResults).toHaveBeenCalledWith(
        DONE_JOB.id,
        expect.objectContaining({ status: "", offset: 0 }),
      );
      expect(container.textContent).toContain("a@example.test");
      expect(container.textContent).toContain("b@example.test");
      expect(container.textContent).toContain("Rows 1 to 3; more available");

      const filter =
        container.querySelector<HTMLSelectElement>("#v-results-filter");
      expect(filter).not.toBeNull();
      expect([...(filter?.options ?? [])].map((o) => o.textContent)).toEqual([
        "All statuses",
        "valid (1)",
        "invalid (2)",
      ]);
      await act(async () => {
        if (filter) choose(filter, "invalid");
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(apiMocks.jobResults).toHaveBeenLastCalledWith(
        DONE_JOB.id,
        expect.objectContaining({ status: "invalid", offset: 0 }),
      );
      expect(container.textContent).not.toContain("a@example.test");
      expect(container.textContent).toContain("mailbox not found");

      const next = button(container, "Next page");
      expect(next?.disabled).toBe(false);
      await act(async () => {
        next?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(apiMocks.jobResults).toHaveBeenLastCalledWith(
        DONE_JOB.id,
        expect.objectContaining({ status: "invalid", offset: 100 }),
      );
      expect(container.textContent).toContain("d@example.test");
      expect(container.textContent).toContain("Rows 101 to 101");
      expect(button(container, "Next page")?.disabled).toBe(true);
      expect(button(container, "Previous page")?.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });
});
