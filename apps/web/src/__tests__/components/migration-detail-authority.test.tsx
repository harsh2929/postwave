// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";
import type { MigrationJob, VerificationReport } from "@/lib/types";
import { renderPage, unmount } from "../pages/_harness";

const mocks = vi.hoisted(() => ({
  loadDetail: vi.fn(),
  loadPilot: vi.fn(),
  getRollbackStatus: vi.fn(),
  rollback: vi.fn(),
  updateJob: vi.fn(),
  verifyAdmin: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));

vi.mock(
  "@/app/(dashboard)/app/migrations/[jobId]/migration-detail-data",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/(dashboard)/app/migrations/[jobId]/migration-detail-data")
    >()),
    loadMigrationDetailData: mocks.loadDetail,
    loadMigrationPilotControls: mocks.loadPilot,
  }),
);

vi.mock("@/lib/migration-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/migration-api")>()),
  getRollbackStatus: mocks.getRollbackStatus,
  rollback: mocks.rollback,
  updateMigrationJob: mocks.updateJob,
}));

const ADMIN: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "admin@example.test",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Authority QA",
  workspace_slug: "authority-qa",
};

const JOB: MigrationJob = {
  id: "migration-1",
  tenant_id: "tenant-1",
  source: "substack",
  status: "failed",
  label: "Original migration",
  progress: {
    subscribers_total: 10,
    subscribers_done: 3,
    segments_total: 0,
    segments_done: 0,
    automations_total: 0,
    automations_done: 0,
    archive_total: 0,
    archive_done: 0,
    paid_subs_total: 0,
    paid_subs_done: 0,
  },
  cursor: {},
  started_at: "2026-09-04T00:00:00Z",
  completed_at: null,
  rollback_until: null,
  verification_report: null,
  error: "provider failed",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function settle(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(ADMIN);
  mocks.verifyAdmin.mockResolvedValue(ADMIN);
  mocks.loadDetail.mockResolvedValue({
    audit: [],
    job: JOB,
    report: null,
  });
  mocks.loadPilot.mockResolvedValue({
    rebuilds: [],
    shadow: null,
    sourceEvents: null,
  });
  mocks.updateJob.mockImplementation(
    async (_id: string, input: { label: string }) => ({
      ...JOB,
      label: input.label,
    }),
  );
  mocks.rollback.mockResolvedValue({ ok: true });
  mocks.getRollbackStatus.mockResolvedValue({
    state: "failed",
    error: "test poll stop",
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("migration detail write authority", () => {
  it("does not present dry-run counts as completed pilot acceptance evidence", async () => {
    const report: VerificationReport = {
      subscribers_imported: 3,
      suppression_list_size: 1,
      custom_fields_mapped: [],
      custom_fields_unmapped: [],
      segments_translated: 0,
      segments_with_warnings: [],
      automations_translated: 0,
      automations_unsupported: [],
      paid_subs_imported: 0,
      archive_imported: 0,
      data_loss_estimate_pct: 0,
    };
    mocks.loadDetail.mockResolvedValue({
      audit: [],
      job: {
        ...JOB,
        source: "csv",
        status: "awaiting_confirmation",
        verification_report: report,
      },
      report,
    });
    mocks.loadPilot.mockResolvedValue({
      rebuilds: [],
      shadow: null,
      sourceEvents: null,
      acceptance: {
        job_id: JOB.id,
        source: "csv",
        status: "blocker",
        generated_at: new Date().toISOString(),
        blockers: 1,
        warnings: 0,
        items: [
          {
            key: "contacts",
            label: "Contacts",
            status: "pass",
            expected: 3,
            actual: 3,
            detail: "Contacts imported exactly.",
          },
        ],
      },
    });
    const Page = (await import("@/app/(dashboard)/app/migrations/[jobId]/page"))
      .default;
    const rendered = await renderPage(Page, {
      params: Promise.resolve({ jobId: JOB.id }),
    });
    try {
      await settle();
      expect(rendered.container.textContent).toContain(
        "Pilot acceptance requires a completed import",
      );
      expect(rendered.container.textContent).not.toContain(
        "Contacts imported exactly",
      );
      expect(rendered.container.textContent).not.toContain("Run delta import");
    } finally {
      unmount(rendered.root);
    }
  });

  it("revalidates before rename and collapses same-tick Save activation", async () => {
    const fresh = deferred<MeResponse>();
    mocks.verifyAdmin.mockReturnValue(fresh.promise);
    const Page = (await import("@/app/(dashboard)/app/migrations/[jobId]/page"))
      .default;
    const rendered = await renderPage(Page, {
      params: Promise.resolve({ jobId: JOB.id }),
    });

    try {
      act(() => button(rendered.container, "Rename migration").click());
      const input = rendered.container.querySelector<HTMLInputElement>(
        'input[aria-label="Migration name"]',
      );
      if (!input) throw new Error("Missing migration name input");
      act(() => setInputValue(input, "Frozen name"));

      act(() => {
        const save = button(rendered.container, "Save");
        save.click();
        save.click();
      });
      expect(mocks.verifyAdmin).toHaveBeenCalledTimes(1);
      expect(mocks.updateJob).not.toHaveBeenCalled();

      act(() => fresh.resolve(ADMIN));
      await settle();
      expect(mocks.updateJob).toHaveBeenCalledTimes(1);
      expect(mocks.updateJob).toHaveBeenCalledWith(JOB.id, {
        label: "Frozen name",
      });
      expect(mocks.verifyAdmin.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.updateJob.mock.invocationCallOrder[0]!,
      );
    } finally {
      unmount(rendered.root);
    }
  });

  it("does not transport a rename after fresh authority fails", async () => {
    mocks.verifyAdmin.mockRejectedValue(
      new Error("Workspace identity or authority changed."),
    );
    const Page = (await import("@/app/(dashboard)/app/migrations/[jobId]/page"))
      .default;
    const rendered = await renderPage(Page, {
      params: Promise.resolve({ jobId: JOB.id }),
    });

    try {
      act(() => button(rendered.container, "Rename migration").click());
      await act(async () => button(rendered.container, "Save").click());
      await settle();
      expect(mocks.verifyAdmin).toHaveBeenCalledTimes(1);
      expect(mocks.updateJob).not.toHaveBeenCalled();
    } finally {
      unmount(rendered.root);
    }
  });

  it("does not poll rollback status until authority and the rollback start succeed", async () => {
    const authority = deferred<void>();
    const beforeWrite = vi.fn(() => authority.promise);
    const { RollbackSection } =
      await import("@/app/(dashboard)/app/migrations/[jobId]/rollback-section");
    const rendered = await renderPage(() => (
      <RollbackSection
        job={JOB}
        report={null}
        source={JOB.source}
        onRolledBack={vi.fn()}
        beforeWrite={beforeWrite}
      />
    ));

    try {
      act(() => button(rendered.container, "Rollback this migration").click());
      const token = document.querySelector<HTMLInputElement>(
        'input[placeholder="DELETE"]',
      );
      if (!token) throw new Error("Missing rollback confirmation token");
      act(() => setInputValue(token, "DELETE"));
      const confirm = button(document.body, "Yes, roll back everything");
      act(() => {
        confirm.click();
        confirm.click();
      });

      expect(beforeWrite).toHaveBeenCalledTimes(1);
      expect(mocks.rollback).not.toHaveBeenCalled();
      expect(mocks.getRollbackStatus).not.toHaveBeenCalled();

      act(() => authority.resolve());
      await settle();
      expect(mocks.rollback).toHaveBeenCalledTimes(1);
      expect(mocks.getRollbackStatus).toHaveBeenCalledTimes(1);
      expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.rollback.mock.invocationCallOrder[0]!,
      );
      expect(mocks.rollback.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.getRollbackStatus.mock.invocationCallOrder[0]!,
      );
    } finally {
      unmount(rendered.root);
    }
  });
});
