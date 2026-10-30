// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportStep } from "@/app/(dashboard)/app/migrations/new/[source]/import-step";
import type { MigrationStreamDone } from "@/lib/migration-progress-api";
import type { MigrationJob } from "@/lib/types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

function job(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job_import",
    tenant_id: "tnt_1",
    source: "mailchimp",
    status: "importing",
    progress: {
      subscribers_total: 10,
      subscribers_done: 4,
      segments_total: 2,
      segments_done: 1,
      automations_total: 1,
      automations_done: 0,
      paid_subs_total: 0,
      paid_subs_done: 0,
      archive_total: 3,
      archive_done: 2,
    },
    cursor: {},
    started_at: "2026-06-28T00:00:00.000Z",
    completed_at: null,
    rollback_until: null,
    verification_report: null,
    error: null,
    ...overrides,
  };
}

function done(
  status: string,
  doneJob: MigrationJob,
  error?: string,
): MigrationStreamDone {
  return {
    status,
    resources: {},
    job: doneJob,
    error,
  };
}

function ProgressStub({
  jobId,
  sourceLabel,
  source,
  onComplete,
}: {
  jobId: string;
  sourceLabel: string;
  source?: string;
  onComplete: (done: MigrationStreamDone) => void;
}) {
  return createElement(
    "div",
    null,
    createElement(
      "p",
      null,
      `Progress for ${sourceLabel} (${jobId}) source=${source ?? "none"}`,
    ),
    createElement(
      "button",
      {
        onClick: () =>
          onComplete(done("completed", job({ id: "job_complete" }))),
      },
      "complete",
    ),
    createElement(
      "button",
      {
        onClick: () =>
          onComplete(
            done("failed", job({ id: "job_failed", status: "failed" }), "boom"),
          ),
      },
      "fail",
    ),
    createElement(
      "button",
      {
        onClick: () =>
          onComplete(
            done(
              "rolled_back",
              job({ id: "job_rolled", status: "rolled_back" }),
            ),
          ),
      },
      "rollback",
    ),
  );
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe("ImportStep", () => {
  it("maps progress completion statuses to toasts and route callbacks", () => {
    const onComplete = vi.fn();
    const root = render(
      createElement(ImportStep, {
        source: "mailchimp",
        state: { jobId: "job_import", job: null },
        onComplete,
        progressView: ProgressStub,
        beforeWrite: vi.fn().mockResolvedValue(undefined),
        authorityKey: "tnt_1:usr_admin:admin:member",
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Progress for Mailchimp (job_import) source=mailchimp",
      );

      act(() => {
        buttonByText("complete").click();
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Migration complete");
      expect(onComplete).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "job_complete" }),
      );

      act(() => {
        buttonByText("fail").click();
      });
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Migration failed",
        expect.objectContaining({ description: "boom" }),
      );
      expect(onComplete).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "job_failed" }),
      );

      act(() => {
        buttonByText("rollback").click();
      });
      expect(mocks.toastInfo).toHaveBeenCalledWith("Migration rolled back");
      expect(onComplete).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "job_rolled" }),
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("passes ActiveCampaign source context into the progress view", () => {
    const root = render(
      createElement(ImportStep, {
        source: "activecampaign",
        state: { jobId: "job_activecampaign", job: null },
        onComplete: vi.fn(),
        progressView: ProgressStub,
        beforeWrite: vi.fn().mockResolvedValue(undefined),
        authorityKey: "tnt_1:usr_admin:admin:member",
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        "Progress for ActiveCampaign (job_activecampaign) source=activecampaign",
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
