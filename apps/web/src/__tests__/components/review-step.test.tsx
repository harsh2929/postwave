// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, useCallback, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReviewStep,
  type ReviewStepState,
} from "@/app/(dashboard)/app/migrations/new/[source]/review-step";
import type { MigrationJob, VerificationReport } from "@/lib/types";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  getJob: vi.fn(),
  getVerification: vi.fn(),
  refreshSourceSessionWithApiKey: vi.fn(),
  startOAuth: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  verifyFreshAdminAuthority: vi.fn(),
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyFreshAdminAuthority,
}));

vi.mock("@/lib/migration-api", () => ({
  commit: mocks.commit,
  getJob: mocks.getJob,
  getVerification: mocks.getVerification,
  refreshSourceSessionWithApiKey: mocks.refreshSourceSessionWithApiKey,
  startOAuth: mocks.startOAuth,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

const ADMIN_IDENTITY: MeResponse = {
  user_id: "usr_admin",
  tenant_id: "tnt_1",
  email: "admin@example.com",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

beforeEach(() => {
  mocks.verifyFreshAdminAuthority.mockResolvedValue(ADMIN_IDENTITY);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
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

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
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

function report(
  overrides: Partial<VerificationReport> = {},
): VerificationReport {
  return {
    subscribers_imported: 100,
    suppression_list_size: 5,
    custom_fields_mapped: [
      {
        source: "FNAME",
        canonical: "first_name",
        type: "string",
      },
    ],
    custom_fields_unmapped: [],
    segments_translated: 7,
    segments_with_warnings: [],
    automations_translated: 2,
    automations_unsupported: [],
    paid_subs_imported: 3,
    archive_imported: 4,
    resource_completeness: [],
    data_loss_estimate_pct: 1,
    ...overrides,
  };
}

function job(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job_dry",
    tenant_id: "tnt_1",
    source: "mailchimp",
    status: "awaiting_confirmation",
    progress: {
      subscribers_total: 0,
      subscribers_done: 0,
      segments_total: 0,
      segments_done: 0,
      automations_total: 0,
      automations_done: 0,
      paid_subs_total: 0,
      paid_subs_done: 0,
      archive_total: 0,
      archive_done: 0,
    },
    cursor: {},
    started_at: "2026-06-28T00:00:00.000Z",
    completed_at: null,
    rollback_until: null,
    source_session_expires_at: "2099-01-01T00:00:00.000Z",
    selected_audience_ids: ["aud_default"],
    verification_report: null,
    error: null,
    ...overrides,
  };
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function inputByID(id: string): HTMLInputElement {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return input;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as typeof HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function ReviewHarness({
  initialState,
  source = "mailchimp",
  onBack = vi.fn(),
  onCommitted = vi.fn(),
}: {
  initialState?: ReviewStepState;
  source?: MigrationJob["source"];
  onBack?: (jobId: string) => void;
  onCommitted?: (jobId: string) => void;
}) {
  const [state, setState] = useState<ReviewStepState>(
    initialState ?? {
      jobId: "job_dry",
      job: null,
      report: null,
      loading: true,
    },
  );
  const handleReportLoaded = useCallback(
    ({
      jobId,
      job: loadedJob,
      report: loadedReport,
    }: {
      jobId: string;
      job: MigrationJob;
      report: VerificationReport;
    }) => {
      setState((current) => ({
        jobId,
        job: loadedJob,
        report: loadedReport,
        loading: false,
        selectedAudiences: current.selectedAudiences,
      }));
    },
    [],
  );
  const handleLoadingChange = useCallback((loading: boolean) => {
    setState((current) => ({ ...current, loading }));
  }, []);
  const handleCommitted = useCallback(
    (jobId: string) => {
      onCommitted(jobId);
    },
    [onCommitted],
  );
  const handleJobRefreshed = useCallback((job: MigrationJob) => {
    setState((current) => ({
      ...current,
      job,
      loading: false,
    }));
  }, []);

  return createElement(ReviewStep, {
    source,
    state,
    onBack,
    onReportLoaded: handleReportLoaded,
    onLoadingChange: handleLoadingChange,
    onCommitted: handleCommitted,
    onJobRefreshed: handleJobRefreshed,
    identity: ADMIN_IDENTITY,
    authorityKey: "tnt_1:usr_admin:admin:member",
    beforeWrite: (signal) =>
      mocks
        .verifyFreshAdminAuthority(ADMIN_IDENTITY, signal)
        .then(() => undefined),
  });
}

describe("ReviewStep", () => {
  it("loads the dry-run report and commits the import", async () => {
    const onCommitted = vi.fn();
    mocks.getJob.mockResolvedValue(
      job({ selected_audience_ids: ["aud_a", "aud_b"] }),
    );
    mocks.getVerification.mockResolvedValue(report());
    mocks.commit.mockResolvedValue({ job_id: "job_import" });

    const root = render(createElement(ReviewHarness, { onCommitted }));

    try {
      await waitFor(() => {
        expect(mocks.getJob).toHaveBeenCalledWith("job_dry", expect.anything());
        expect(mocks.getVerification).toHaveBeenCalledWith(
          "job_dry",
          expect.anything(),
        );
        expect(document.body.textContent).toContain("Plan review");
        expect(document.body.textContent).toContain("Full dry-run breakdown");
        expect(document.body.textContent).toContain("Mailchimp audience scope");
        expect(document.body.textContent).toContain("aud_a");
        expect(document.body.textContent).toContain("aud_b");
      });

      await act(async () => {
        buttonByText("start the real import").click();
        await flush();
      });

      expect(mocks.commit).toHaveBeenCalledWith(
        "mailchimp",
        "job_dry",
        ["aud_a", "aud_b"],
        undefined,
        expect.anything(),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Migration committed",
        expect.objectContaining({
          description: expect.stringContaining("Importing now"),
        }),
      );
      expect(onCommitted).toHaveBeenCalledWith("job_import");
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("shows selected audience names and counts when discovery details are carried into review", async () => {
    const selectedJob = job({
      selected_audience_ids: ["list_newsletter"],
    });
    mocks.getJob.mockResolvedValue(selectedJob);
    mocks.getVerification.mockResolvedValue(report());

    const root = render(
      createElement(ReviewHarness, {
        initialState: {
          jobId: "job_dry",
          job: selectedJob,
          report: report(),
          loading: false,
          selectedAudiences: [
            {
              id: "list_newsletter",
              name: "Newsletter",
              subscribers_total: 8800,
            },
          ],
        },
      }),
    );

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Mailchimp audience scope");
        expect(document.body.textContent).toContain("Newsletter");
        expect(document.body.textContent).toContain("8,800 subscribers");
        expect(document.body.textContent).toContain("list_newsletter");
        expect(document.body.textContent).toContain(
          "Review account-global Mailchimp surfaces",
        );
        expect(document.body.textContent).toContain(
          "Templates, landing pages, ecommerce evidence",
        );
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("warns but allows commit when the source session is near expiry", async () => {
    const nearExpiryJob = job({
      source_session_expires_at: new Date(
        Date.now() + 12 * 60 * 60 * 1000,
      ).toISOString(),
    });
    mocks.getJob.mockResolvedValue(nearExpiryJob);
    mocks.getVerification.mockResolvedValue(report());
    mocks.commit.mockResolvedValue({ job_id: "job_import" });

    const root = render(
      createElement(ReviewHarness, {
        initialState: {
          jobId: "job_dry",
          job: nearExpiryJob,
          report: report(),
          loading: false,
        },
      }),
    );

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Mailchimp session expires soon",
        );
        expect(document.body.textContent).toContain(
          "You can continue the real import",
        );
        expect(document.body.textContent).toContain("Reconnect this migration");
      });

      expect(buttonByText("Commit migration").disabled).toBe(false);
      expect(buttonByText("start the real import").disabled).toBe(false);

      await act(async () => {
        buttonByText("Commit migration").click();
        await flush();
      });
      expect(mocks.commit).toHaveBeenCalledWith(
        "mailchimp",
        "job_dry",
        ["aud_default"],
        undefined,
        expect.anything(),
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("schedules the import for a future time and blocks a past time (MIGR-038)", async () => {
    const onCommitted = vi.fn();
    const scopedJob = job({ selected_audience_ids: ["aud_a"] });
    mocks.getJob.mockResolvedValue(scopedJob);
    mocks.getVerification.mockResolvedValue(report());
    mocks.commit.mockResolvedValue({ job_id: "job_import" });

    const root = render(
      createElement(ReviewHarness, {
        onCommitted,
        initialState: {
          jobId: "job_dry",
          job: scopedJob,
          report: report(),
          loading: false,
        },
      }),
    );

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Schedule (optional)");
      });

      // A past time disables the Commit controls but (MIGR-038 F6) keeps
      // navigation available; commit() is never called.
      changeInput(inputByID("migration-schedule-at"), "2000-01-01T00:00");
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Pick a time in the future",
        );
        expect(buttonByText("start the real import").disabled).toBe(true);
        expect(buttonByText("Commit migration").disabled).toBe(true);
        expect(buttonByText("Cancel").disabled).toBe(false);
      });
      expect(mocks.commit).not.toHaveBeenCalled();

      // A future time re-enables and commits with the ISO instant.
      const future = new Date(Date.now() + 60 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const localValue =
        `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}` +
        `T${pad(future.getHours())}:${pad(future.getMinutes())}`;
      changeInput(inputByID("migration-schedule-at"), localValue);
      await waitFor(() => {
        expect(buttonByText("Commit migration").disabled).toBe(false);
      });
      await act(async () => {
        buttonByText("Commit migration").click();
        await flush();
      });

      expect(mocks.commit).toHaveBeenCalledWith(
        "mailchimp",
        "job_dry",
        ["aud_a"],
        new Date(localValue).toISOString(),
        expect.anything(),
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Migration scheduled",
        expect.objectContaining({
          description: expect.stringContaining("Import will start"),
        }),
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("surfaces the failed job error before requesting a missing report", async () => {
    mocks.getJob.mockResolvedValue(
      job({ status: "failed", error: "Source API rejected the credentials" }),
    );

    const root = render(createElement(ReviewHarness));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Couldn't load the dry-run",
        );
        expect(document.body.textContent).toContain(
          "Source API rejected the credentials",
        );
      });
      expect(mocks.getVerification).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("fails closed when a Mailchimp dry-run job has no saved audience scope", async () => {
    const unscopedJob = job({ selected_audience_ids: [] });
    mocks.getJob.mockResolvedValue(unscopedJob);
    mocks.getVerification.mockResolvedValue(report());

    const root = render(
      createElement(ReviewHarness, {
        initialState: {
          jobId: "job_dry",
          job: unscopedJob,
          report: report(),
          loading: false,
        },
      }),
    );

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Mailchimp audience scope is missing",
        );
      });
      expect(buttonByText("Commit migration").disabled).toBe(true);
      expect(buttonByText("start the real import").disabled).toBe(true);
      expect(mocks.commit).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("blocks commit when the saved source session is unavailable", async () => {
    const missingSessionJob = job({
      source_session_expires_at: null,
    });
    mocks.getJob.mockResolvedValue(missingSessionJob);
    mocks.getVerification.mockResolvedValue(report());

    const root = render(
      createElement(ReviewHarness, {
        initialState: {
          jobId: "job_dry",
          job: missingSessionJob,
          report: report(),
          loading: false,
        },
      }),
    );

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Reconnect Mailchimp");
        expect(document.body.textContent).toContain(
          "The saved Mailchimp session is no longer available",
        );
      });

      expect(buttonByText("Commit migration").disabled).toBe(true);
      expect(buttonByText("start the real import").disabled).toBe(true);
      expect(mocks.commit).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("refreshes an existing ActiveCampaign dry-run job before commit", async () => {
    const expiredJob = job({
      source: "activecampaign",
      source_session_expires_at: null,
    });
    const refreshedJob = job({
      source: "activecampaign",
      source_session_expires_at: "2099-01-01T00:00:00.000Z",
    });
    mocks.getJob.mockResolvedValue(expiredJob);
    mocks.getVerification.mockResolvedValue(report());
    mocks.refreshSourceSessionWithApiKey.mockResolvedValue(refreshedJob);

    const root = render(
      createElement(ReviewHarness, {
        source: "activecampaign",
        initialState: {
          jobId: "job_dry",
          job: expiredJob,
          report: report(),
          loading: false,
        },
      }),
    );

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Reconnect ActiveCampaign");
        expect(buttonByText("Commit migration").disabled).toBe(true);
      });

      await act(async () => {
        changeInput(
          inputByID("activecampaign-refresh-api-url-job_dry"),
          "https://acme.api-us1.com/api/3",
        );
        changeInput(
          inputByID("activecampaign-refresh-api-token-job_dry"),
          "new_token",
        );
        await flush();
      });

      await act(async () => {
        buttonByText("Refresh source session").click();
        await flush();
      });

      await waitFor(() => {
        expect(mocks.refreshSourceSessionWithApiKey).toHaveBeenCalledWith(
          "job_dry",
          "activecampaign",
          "new_token",
          "https://acme.api-us1.com/api/3",
          undefined,
          expect.anything(),
        );
        expect(document.body.textContent).not.toContain(
          "Reconnect ActiveCampaign",
        );
        expect(buttonByText("Commit migration").disabled).toBe(false);
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("blocks and refreshes a near-expiry Beehiiv dry-run on the same job", async () => {
    const nearExpiryJob = job({
      source: "beehiiv",
      selected_audience_ids: undefined,
      source_session_expires_at: new Date(
        Date.now() + 13 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    const refreshedJob = job({
      source: "beehiiv",
      selected_audience_ids: undefined,
      source_session_expires_at: "2099-01-01T00:00:00.000Z",
    });
    mocks.getJob.mockResolvedValue(nearExpiryJob);
    mocks.getVerification.mockResolvedValue(report());
    mocks.refreshSourceSessionWithApiKey.mockResolvedValue(refreshedJob);

    const root = render(
      createElement(ReviewHarness, {
        source: "beehiiv",
        initialState: {
          jobId: "job_dry",
          job: nearExpiryJob,
          report: report(),
          loading: false,
        },
      }),
    );

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Reconnect Beehiiv");
        expect(document.body.textContent).toContain(
          "Reconnect before starting the real import",
        );
        expect(buttonByText("Commit migration").disabled).toBe(true);
      });

      await act(async () => {
        changeInput(
          inputByID("beehiiv-refresh-api-token-job_dry"),
          "new_beehiiv_key",
        );
        await flush();
      });
      await act(async () => {
        buttonByText("Refresh source session").click();
        await flush();
      });

      await waitFor(() => {
        expect(mocks.refreshSourceSessionWithApiKey).toHaveBeenCalledWith(
          "job_dry",
          "beehiiv",
          "new_beehiiv_key",
          undefined,
          undefined,
          expect.anything(),
        );
        expect(document.body.textContent).not.toContain("Reconnect Beehiiv");
        expect(buttonByText("Commit migration").disabled).toBe(false);
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("surfaces terminal polling errors and retries on demand", async () => {
    const onBack = vi.fn();
    mocks.getJob
      .mockRejectedValueOnce(new Error("job missing"))
      .mockResolvedValueOnce(job());
    mocks.getVerification.mockResolvedValue(report());

    const root = render(createElement(ReviewHarness, { onBack }));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Couldn't load the dry-run",
        );
        expect(document.body.textContent).toContain("job missing");
      });

      act(() => {
        buttonByText("Back").click();
      });
      expect(onBack).toHaveBeenCalledWith("job_dry");

      await act(async () => {
        buttonByText("Try again").click();
        await flush();
      });

      await waitFor(() => {
        expect(mocks.getJob).toHaveBeenCalledTimes(2);
        expect(document.body.textContent).toContain("Plan review");
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
