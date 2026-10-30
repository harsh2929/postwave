// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Parity rows audience-16 (CSV import: consent-evidence step, preflight
// acknowledgements, in-flight recovery), audience-41 (browse by engagement
// score) and audience-5 (per-user column preferences).
import { act, createElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code = `http_${status}`,
    ) {
      super(message);
    }
  }
  return {
    MockApiError,
    get: vi.fn(
      async (
        _path: string,
        _opts?: { query?: Record<string, unknown>; signal?: AbortSignal },
      ): Promise<unknown> => ({}),
    ),
    post: vi.fn(
      async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> => ({}),
    ),
    patch: vi.fn(
      async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> => ({}),
    ),
    put: vi.fn(
      async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> => ({}),
    ),
    whoami: vi.fn(),
    whoamiFresh: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      message: vi.fn(),
    },
  };
});

vi.mock("@/lib/api", () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    put: mocks.put,
    delete: vi.fn(),
  },
  ApiError: mocks.MockApiError,
  isApiError: (error: unknown) => error instanceof mocks.MockApiError,
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement("a", { href, ...rest }, children),
  };
});

import { ColumnPicker, useDirectoryColumns } from "@/components/subscribers/ColumnPicker";
import {
  ImportConsentEvidenceStep,
  ImportPreflightAcknowledgements,
  InFlightImportRecovery,
} from "@/components/subscribers/CsvImportWizardSteps";
import { ScoreDistributionBrowser } from "@/components/subscribers/ScoreDistributionBrowser";
import {
  importAcknowledgementProblem,
  type ImportAcknowledgements,
} from "@/lib/subscriber-imports-api";

import {
  button,
  cleanup,
  click,
  field,
  flush,
  queryButton,
  render,
  topDialog,
  type,
} from "../helpers/subscriber-directory-harness";

const ME = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.com",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
};
const EDITOR = { ...ME, role: "editor", effective_role: "editor" };
const VIEWER = { ...ME, role: "viewer", effective_role: "viewer" };
const IMPORT = "12121212-1212-4212-8212-121212121212";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(ME);
  mocks.whoamiFresh.mockResolvedValue(ME);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("CSV import consent-evidence step (audience-16)", () => {
  function mountStep(revision = 4) {
    const onSaved = vi.fn();
    render(createElement(ImportConsentEvidenceStep, { importId: IMPORT, revision, onSaved }));
    return onSaved;
  }

  it("persists 'no proof' as an explicit cleared consent contract", async () => {
    mocks.patch.mockResolvedValue({ id: IMPORT, status: "preview", updated: true, configuration_revision: 5 });
    const onSaved = mountStep();
    click(button("Continue without proof"));
    await flush();
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscriber-imports/${IMPORT}`,
      { configuration_revision: 4, consent_scope_acknowledged: false },
      { maxAttempts: 1, requireOnline: true },
    );
    expect(onSaved).toHaveBeenCalledWith({ revision: 5, mode: "none" });
  });

  it("sends the complete first-party proof on the PATCH, never on confirm", async () => {
    mocks.patch.mockResolvedValue({ id: IMPORT, status: "preview", updated: true, configuration_revision: 5 });
    const onSaved = mountStep();
    click(field(/^I hold first-party email-marketing consent/) as HTMLInputElement);
    type(field("Proof type"), "double_optin");
    type(field("Captured at"), "2026-08-30T12:00");
    type(field("Evidence URL (HTTPS)"), "https://forms.example.com/consent/export-2026-08");
    type(field("Jurisdiction"), "gb");
    type(field("Policy version"), "privacy-2026-06");
    type(field("Evidence reference"), "receipt:CONSENT-123");
    type(field("Audit reason"), "Export of confirmed double opt-in signups");
    click(field(/^This proof covers email marketing only/) as HTMLInputElement);
    type(field("Type EMAIL MARKETING to confirm the scope"), "EMAIL MARKETING");
    click(button("Save proof & run preflight"));
    await flush();

    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscriber-imports/${IMPORT}`,
      {
        configuration_revision: 4,
        consent_scope_acknowledged: true,
        consent_source: "double_optin",
        consent_source_url: "https://forms.example.com/consent/export-2026-08",
        consent_captured_at: new Date("2026-08-30T12:00").toISOString(),
        consent_legal_basis: "consent",
        consent_jurisdiction: "GB",
        consent_reason: "Export of confirmed double opt-in signups",
        consent_policy_version: "privacy-2026-06",
        consent_evidence_reference: "receipt:CONSENT-123",
        consent_scope: "email_marketing",
      },
      { maxAttempts: 1, requireOnline: true },
    );
    expect(mocks.post).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith({ revision: 5, mode: "verified" });
  });

  it("refuses unsafe or incomplete proof and says which field is wrong", async () => {
    mountStep();
    click(field(/^I hold first-party email-marketing consent/) as HTMLInputElement);
    type(field("Proof type"), "double_optin");
    type(field("Captured at"), "2026-08-30T12:00");
    type(field("Evidence URL (HTTPS)"), "http://forms.example.com/export?token=abc");
    type(field("Jurisdiction"), "gb");
    type(field("Policy version"), "privacy-2026-06");
    type(field("Evidence reference"), "receipt:CONSENT-123");
    type(field("Audit reason"), "Contact ada@example.com confirmed");
    click(field(/^This proof covers email marketing only/) as HTMLInputElement);
    type(field("Type EMAIL MARKETING to confirm the scope"), "email marketing");
    click(button("Save proof & run preflight"));
    await flush();
    expect(mocks.patch).not.toHaveBeenCalled();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Use an absolute HTTPS evidence URL");
    expect(text).toContain("Do not place personal data or secrets here");
    expect(text).toContain("Type EMAIL MARKETING exactly to confirm the scope.");
  });
});

describe("CSV import preflight acknowledgements (audience-16)", () => {
  it("gates the commit until the preflight — and any failing rows — are acknowledged", () => {
    const dryRun = { would_create: 90, would_update: 5, would_skip: 3, would_fail: 2 };
    let value: ImportAcknowledgements = { queue: false, failures: false };
    const onChange = vi.fn((next: ImportAcknowledgements) => {
      value = next;
    });
    const view = (): ReactElement =>
      createElement(ImportPreflightAcknowledgements, { dryRun, value, onChange });
    const { root } = render(view());
    expect(importAcknowledgementProblem(dryRun, value)).toBe(
      "Confirm you reviewed the preflight before queueing.",
    );
    click(field(/^I reviewed the preflight: 90 to create, 5 to update, 3 to skip/) as HTMLInputElement);
    expect(onChange).toHaveBeenLastCalledWith({ queue: true, failures: false });
    act(() => root.render(view()));
    expect(importAcknowledgementProblem(dryRun, value)).toBe(
      "Acknowledge that the failing rows will not be imported.",
    );
    click(field(/^2 rows will fail and will not be imported/) as HTMLInputElement);
    expect(importAcknowledgementProblem(dryRun, value)).toBeNull();
    expect(importAcknowledgementProblem({ ...dryRun, would_fail: 0 }, { queue: true, failures: false })).toBeNull();
  });
});

describe("CSV import in-flight recovery (audience-16)", () => {
  it("lists running imports with progress and cancels one only after confirming", async () => {
    mocks.get.mockImplementation(async (path) => {
      if (path === "/api/v1/subscriber-imports")
        return {
          imports: [
            { id: IMPORT, filename: "leads.csv", status: "running", rows_total: 2000, processed_rows: 500, cancel_requested: false },
            { id: "done", filename: "old.csv", status: "ready", rows_total: 10, processed_rows: 10 },
          ],
          has_more: false,
          next_cursor: "",
        };
      throw new Error(`unexpected GET ${path}`);
    });
    mocks.post.mockResolvedValue({ id: IMPORT, status: "running", cancel_requested: true });
    const onResume = vi.fn();
    render(createElement(InFlightImportRecovery, { onResume }));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/subscriber-imports", { query: { limit: 20 } });
    const text = document.body.textContent ?? "";
    expect(text).toContain("An import is still running");
    expect(text).toContain("leads.csv · running · 500 of 2,000 rows (25%)");
    expect(text).not.toContain("old.csv");

    click(button("Show progress"));
    expect(onResume).toHaveBeenCalledWith(IMPORT);

    click(button("Cancel…"));
    await flush();
    const confirm = topDialog();
    expect(confirm.textContent).toContain("Cancel importing leads.csv?");
    expect(confirm.textContent).toContain("Rows already imported stay imported");
    expect(mocks.post).not.toHaveBeenCalled();
    click(button("Cancel import", confirm));
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/subscriber-imports/${IMPORT}/cancel`,
      {},
      { maxAttempts: 1 },
    );
  });

  it("makes no import request for a role without the admin scope", async () => {
    mocks.whoami.mockResolvedValue(EDITOR);
    render(createElement(InFlightImportRecovery));
    await flush();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });
});

describe("browse by engagement score (audience-41)", () => {
  const buckets = [
    { range: "0..12", min: 0, max: 12, count: 40 },
    { range: "13..40", min: 13, max: 40, count: 38 },
  ];

  function page(pageNumber: number) {
    return {
      items: [
        { id: `sub-${pageNumber}-a`, email: `a${pageNumber}@example.com`, score: 40 },
        { id: `sub-${pageNumber}-b`, email: `b${pageNumber}@example.com`, score: 37 },
      ],
      page: pageNumber,
      per_page: 25,
      total: 38,
    };
  }

  it("lists a bucket's subscribers, links each to its profile, and pages", async () => {
    mocks.get.mockImplementation(async (_path, opts) => page(Number(opts?.query?.page ?? 1)));
    render(createElement(ScoreDistributionBrowser, { buckets, queryKeyPrefix: ["workspace-ops", "t", "owner"] }));
    click(button("13..40"));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/engagement-scores/subscribers", {
      query: { min: 13, max: 40, page: 1, per_page: 25 },
      signal: expect.any(AbortSignal),
    });
    const links = [...document.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["a1@example.com", "/app/subscribers/sub-1-a"],
      ["b1@example.com", "/app/subscribers/sub-1-b"],
    ]);
    expect(document.body.textContent).toContain("38 in range · page 1 of 2");
    click(button("Next"));
    await flush();
    expect(mocks.get).toHaveBeenLastCalledWith("/api/v1/engagement-scores/subscribers", {
      query: { min: 13, max: 40, page: 2, per_page: 25 },
      signal: expect.any(AbortSignal),
    });
  });

  it("browses a typed open-ended range and rejects an inverted one", async () => {
    mocks.get.mockImplementation(async () => page(1));
    render(createElement(ScoreDistributionBrowser, { buckets, queryKeyPrefix: ["k"] }));
    type(field("Min score"), "50");
    type(field("Max score"), "10");
    click(button("Browse"));
    await flush();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("The minimum cannot be above the maximum.");
    type(field("Max score"), "");
    click(button("Browse"));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/engagement-scores/subscribers", {
      query: { min: 50, max: undefined, page: 1, per_page: 25 },
      signal: expect.any(AbortSignal),
    });
  });
});

describe("column picker (audience-5)", () => {
  function Harness() {
    const controller = useDirectoryColumns();
    return createElement(
      "div",
      null,
      createElement(ColumnPicker, { controller }),
      createElement("output", { "data-testid": "visible" }, controller.columns.join(",")),
    );
  }

  it("reads the saved set and PUTs the whole preference, keeping widths, after a debounce", async () => {
    mocks.get.mockResolvedValue({ columns: ["email", "status"], widths: { email: 240, bogus: 5 }, sort: "email", order: "asc" });
    mocks.put.mockImplementation(async (_path, body) => body);
    render(createElement(Harness));
    await flush();
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/me/prefs/subscribers_view", {
      signal: expect.any(AbortSignal),
    });
    const visible = () => document.querySelector('[data-testid="visible"]')?.textContent;
    expect(visible()).toBe("email,status");

    click(button("Columns"));
    await flush();
    const dialog = topDialog();
    expect((field(/^Email/, dialog) as HTMLInputElement).disabled).toBe(true);
    vi.useFakeTimers();
    click(field("Churn score", dialog) as HTMLInputElement);
    click(field("Status", dialog) as HTMLInputElement);
    expect(visible()).toBe("email,churn_score");
    expect(mocks.put).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();
    await flush();
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/v1/me/prefs/subscribers_view",
      { columns: ["email", "churn_score"], widths: { email: 240 }, sort: "email", order: "asc" },
      expect.objectContaining({ maxAttempts: 1, requireOnline: true }),
    );
  });

  it("does not persist a viewer's column choice", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    mocks.get.mockResolvedValue({});
    render(createElement(Harness));
    await flush();
    click(button("Columns"));
    await flush();
    const dialog = topDialog();
    expect(dialog.textContent).toContain("column choices are not saved for this role");
    const rating = field("Rating", dialog) as HTMLInputElement;
    expect(rating.closest("fieldset")?.disabled).toBe(true);
    click(rating);
    await flush();
    expect(document.querySelector('[data-testid="visible"]')?.textContent).toBe(
      "avatar,email,status,joined,engagement,tags",
    );
    expect(queryButton("Save")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
