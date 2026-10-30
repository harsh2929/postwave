// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  ScheduledReport,
  ScheduledReportSendNowReceipt,
} from "../../lib/api-client";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  create: vi.fn(),
  list: vi.fn(),
  me: {
    user: "admin@example.com",
    tenant: "tenant-a",
    role: "admin" as "admin" | "editor" | "viewer",
    effectiveRole: "admin" as "admin" | "editor" | "viewer",
  },
  newSendNowKey: vi.fn(),
  remove: vi.fn(),
  sendNow: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => mocks.me,
}));

vi.mock("../../lib/api-client", () => ({
  scheduledReportsApi: {
    create: mocks.create,
    list: mocks.list,
    newSendNowKey: mocks.newSendNowKey,
    remove: mocks.remove,
    sendNow: mocks.sendNow,
    update: mocks.update,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { ScheduledReportsSection } from "../../components/analytics/ScheduledReportsSection";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.me = {
    user: "admin@example.com",
    tenant: "tenant-a",
    role: "admin",
    effectiveRole: "admin",
  };
  for (const mock of [
    mocks.create,
    mocks.list,
    mocks.newSendNowKey,
    mocks.remove,
    mocks.sendNow,
    mocks.toastError,
    mocks.toastSuccess,
    mocks.update,
  ]) {
    mock.mockReset();
  }
  mocks.list.mockResolvedValue({ data: { reports: [report()] } });
  mocks.newSendNowKey.mockReturnValue("stable-send-key");
  mocks.remove.mockResolvedValue({ data: { deleted: true } });
  mocks.sendNow.mockResolvedValue({ data: sendReceipt() });
  mocks.update.mockResolvedValue({ data: { updated: true } });
  mocks.create.mockResolvedValue({
    data: {
      id: REPORT_ID,
      next_due_at: "2026-07-27T13:30:00.000Z",
      timezone: "Asia/Kolkata",
    },
  });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

describe("scheduled analytics report administration", () => {
  it("lazy-loads verified evidence, keeps recipient PII out of cards, and reviews before queueing", async () => {
    renderSection();
    expect(mocks.list).not.toHaveBeenCalled();

    await expandAndLoad();

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(container?.textContent).toContain("Monday engagement digest");
    expect(container?.textContent).toContain("Provider accepted");
    expect(container?.textContent).toContain("Needs review");
    expect(container?.textContent).toContain("2 configured recipients");
    expect(container?.textContent).not.toContain("owner@example.com");
    expect(container?.querySelector("h3.sr-only")).not.toBeNull();
    expect(
      container
        ?.querySelector(".analytics-scheduled-reports")
        ?.getAttribute("aria-busy"),
    ).toBeNull();

    await click(button("Review a one-off run of Monday engagement digest"));

    expect(mocks.sendNow).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Review the blast radius");
    expect(document.body.textContent).toContain("All 2 configured recipients");
    expect(document.body.textContent).toContain(
      "Queuing another run can contact recipients",
    );
    expect(document.body.textContent).not.toContain("owner@example.com");

    await click(button("Queue another run"));

    expect(mocks.newSendNowKey).toHaveBeenCalledTimes(1);
    expect(mocks.sendNow).toHaveBeenCalledTimes(1);
    expect(mocks.sendNow.mock.calls[0]?.[0]).toBe(REPORT_ID);
    expect(mocks.sendNow.mock.calls[0]?.[1]).toBe("stable-send-key");
    expect(mocks.sendNow.mock.calls[0]?.[2]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/queued.*not delivered/i),
    );
    expect(mocks.toastSuccess.mock.calls[0]?.[0]).not.toContain(
      "owner@example.com",
    );
  });

  it("reuses one request identity after an ambiguous queue response", async () => {
    mocks.sendNow
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          code: "request_failed",
          message: "secret upstream socket detail",
        },
      })
      .mockResolvedValueOnce({ data: sendReceipt() });
    renderSection();
    await expandAndLoad();
    await click(button("Review a one-off run of Monday engagement digest"));
    await click(button("Queue another run"));

    expect(document.body.textContent).toContain(
      "The queue response could not be confirmed",
    );
    expect(document.body.textContent).toContain(
      "reuses the original request identity",
    );
    expect(document.body.textContent).not.toContain(
      "secret upstream socket detail",
    );

    await click(button("Retry same request"));

    expect(mocks.newSendNowKey).toHaveBeenCalledTimes(1);
    expect(mocks.sendNow).toHaveBeenCalledTimes(2);
    expect(mocks.sendNow.mock.calls.map((call) => call[1])).toEqual([
      "stable-send-key",
      "stable-send-key",
    ]);
  });

  it("fails closed on a malformed receipt-bearing response", async () => {
    mocks.list.mockResolvedValue({
      data: {
        reports: [
          report({
            latest_run_status:
              "invented" as ScheduledReport["latest_run_status"],
          }),
        ],
      },
    });
    renderSection();
    await expandAndLoad();

    expect(container?.textContent).toContain(
      "Scheduled report evidence could not be verified",
    );
    expect(container?.textContent).toContain(
      "invalid_scheduled_reports_response",
    );
    expect(container?.textContent).not.toContain("Monday engagement digest");
    expect(container?.textContent).not.toContain("owner@example.com");
  });

  it("retains clearly-labelled last-verified evidence when refresh fails", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: { reports: [report()] } })
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          code: "refresh_failed",
          message: "private transport detail",
        },
      });
    renderSection();
    await expandAndLoad();
    await click(button("Refresh"));

    expect(container?.textContent).toContain(
      "Refresh not confirmed — showing last verified evidence",
    );
    expect(container?.textContent).toContain("Monday engagement digest");
    expect(container?.textContent).toContain(
      "The service could not be reached",
    );
    expect(container?.textContent).not.toContain("private transport detail");
    expect(container?.textContent).not.toContain("owner@example.com");
  });

  it("hides recipient-bearing state immediately on a role downgrade and ignores the late read", async () => {
    const pending = deferred<{
      data: { reports: ScheduledReport[] };
    }>();
    mocks.list.mockReturnValueOnce(pending.promise);
    renderSection();

    await click(button("Scheduled reports"));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    const oldSignal = mocks.list.mock.calls[0]?.[0]?.signal as
      | AbortSignal
      | undefined;

    mocks.canAdmin = false;
    mocks.me = {
      ...mocks.me,
      effectiveRole: "viewer",
    };
    await rerender();

    expect(oldSignal?.aborted).toBe(true);
    expect(container?.textContent).toContain("Admin-only delivery settings");
    expect(container?.textContent).not.toContain("owner@example.com");
    expect(container?.textContent).not.toContain("Monday engagement digest");

    pending.resolve({ data: { reports: [report()] } });
    await flush();

    expect(container?.textContent).not.toContain("owner@example.com");
    expect(container?.textContent).not.toContain("Monday engagement digest");
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("never requests recipient-bearing definitions for a non-admin", async () => {
    mocks.canAdmin = false;
    mocks.me = {
      user: "viewer@example.com",
      tenant: "tenant-a",
      role: "viewer",
      effectiveRole: "viewer",
    };
    renderSection();
    await click(button("Scheduled reports"));

    expect(mocks.list).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Admin-only delivery settings");
    expect(container?.textContent).toContain("current viewer role");
    expect(container?.textContent).not.toContain("New report");
    expect(container?.textContent).not.toContain("owner@example.com");
  });

  it("removes an open recipient editor in the identity-change render", async () => {
    renderSection();
    await expandAndLoad();
    await click(button("Edit"));
    expect(document.body.textContent).toContain("owner@example.com");

    mocks.canAdmin = false;
    mocks.me = {
      ...mocks.me,
      effectiveRole: "viewer",
    };
    await rerender();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain("owner@example.com");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps mailbox PII inside the editor and sends the exact patch contract", async () => {
    renderSection();
    await expandAndLoad();
    await click(button("Edit"));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("owner@example.com");
    expect(
      dialog?.querySelector<HTMLSelectElement>("select:disabled")?.value,
    ).toBe("engagement_summary");

    const name = fieldByLabel<HTMLInputElement>("Name");
    const timezone = fieldByLabel<HTMLInputElement>("Timezone");
    const recipients = fieldByLabel<HTMLTextAreaElement>("Recipients");
    await input(name, "Executive weekly evidence");
    await input(timezone, "UTC");
    await input(
      recipients,
      "finance@example.com\nFINANCE@example.com\nops@example.com",
    );
    await click(button("Save changes"));

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0]?.[0]).toBe(REPORT_ID);
    expect(mocks.update.mock.calls[0]?.[1]).toEqual({
      name: "Executive weekly evidence",
      schedule: "weekly:mon@09:00",
      timezone: "UTC",
      recipients: ["finance@example.com", "ops@example.com"],
      enabled: true,
    });
    expect(mocks.update.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.toastSuccess.mock.calls[0]?.[0]).not.toContain(
      "finance@example.com",
    );
  });

  it("protects a dirty definition from accidental dismissal", async () => {
    renderSection();
    await expandAndLoad();
    await click(button("Edit"));
    await input(
      fieldByLabel<HTMLInputElement>("Name"),
      "Unsaved executive report",
    );

    await click(button("Cancel"));

    let confirmation = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    expect(confirmation?.textContent).toContain(
      "Discard unsaved report changes?",
    );
    expect(fieldByLabel<HTMLInputElement>("Name").value).toBe(
      "Unsaved executive report",
    );

    await click(buttonWithin(confirmation!, "Cancel"));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await click(button("Cancel"));
    confirmation = document.querySelector<HTMLElement>('[role="alertdialog"]');
    await click(buttonWithin(confirmation!, "Discard changes"));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps destructive review private and uses an abortable delete request", async () => {
    renderSection();
    await expandAndLoad();
    await click(button("Delete Monday engagement digest"));

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(
      "Historical run evidence remains retained",
    );
    expect(dialog?.textContent).not.toContain("owner@example.com");

    await click(button("Delete report"));

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove.mock.calls[0]?.[0]).toBe(REPORT_ID);
    expect(mocks.remove.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Deleted “Monday engagement digest”",
    );
  });

  it("has no serious accessibility violations in evidence and editor states", async () => {
    renderSection();
    await expandAndLoad();

    expect(seriousViolations(await axe.run(container!))).toEqual([]);

    await click(button("Edit"));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(seriousViolations(await axe.run(dialog!))).toEqual([]);
    expect(document.querySelector("[title]")).toBeNull();
  });
});

function renderSection(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ScheduledReportsSection />));
}

async function rerender(): Promise<void> {
  await act(async () => {
    root?.render(<ScheduledReportsSection />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function expandAndLoad(): Promise<void> {
  await click(button("Scheduled reports"));
}

function button(label: string): HTMLButtonElement {
  return buttonWithin(document, label);
}

function buttonWithin(rootNode: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(rootNode.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function input(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const prototype =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function fieldByLabel<T extends HTMLElement>(label: string): T {
  const labelNode = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === `${label} (required)`,
  );
  const id = labelNode?.getAttribute("for");
  const control = id ? document.getElementById(id) : null;
  if (!control) throw new Error(`Expected field: ${label}`);
  return control as T;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
}

function sendReceipt(): ScheduledReportSendNowReceipt {
  return {
    queued: true,
    run_id: RUN_ID,
    scheduled_report_id: REPORT_ID,
    run_kind: "manual",
    status: "queued",
    occurrence_at: "2026-07-26T08:00:00.000Z",
    created_at: "2026-07-26T08:00:00.000Z",
  };
}

function report(overrides: Partial<ScheduledReport> = {}): ScheduledReport {
  return {
    id: REPORT_ID,
    name: "Monday engagement digest",
    enabled: true,
    template: "engagement_summary",
    schedule: "weekly:mon@09:00",
    timezone: "Asia/Kolkata",
    recipients: ["owner@example.com", "ops@example.com"],
    last_run_at: "2026-07-26T08:05:00.000Z",
    latest_run_id: RUN_ID,
    latest_run_status: "needs_review",
    latest_run_created_at: "2026-07-26T08:00:00.000Z",
    latest_run_accepted_count: 1,
    latest_run_failed_count: 0,
    latest_run_unknown_count: 1,
    latest_run_recipient_count: 2,
    next_due_at: "2026-07-27T03:30:00.000Z",
    created_at: "2026-07-15T09:00:00.000Z",
    ...overrides,
  };
}
