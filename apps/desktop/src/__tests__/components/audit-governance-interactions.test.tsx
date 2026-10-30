// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
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

const mocks = vi.hoisted(() => ({
  canConfigureRetention: true,
  scopesLoading: false,
  scopesError: null as string | null,
  getRetention: vi.fn(),
  setRetention: vi.fn(),
  getAnomalies: vi.fn(),
  replayBulk: vi.fn(),
  writeClipboard: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/auditScopes", () => ({
  useAuditScopes: () => ({
    hasScope: () => mocks.canConfigureRetention,
    loading: mocks.scopesLoading,
    error: mocks.scopesError,
  }),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getAuditRetention: mocks.getRetention,
      setAuditRetention: mocks.setRetention,
      getAuditRecentAnomalies: mocks.getAnomalies,
      replayDLQBulk: mocks.replayBulk,
    },
  };
});

vi.mock("../../lib/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/clipboard")>();
  return { ...actual, writeClipboardText: mocks.writeClipboard };
});

vi.mock("../../components/Toast", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../components/Toast")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      error: mocks.toastError,
      success: mocks.toastSuccess,
    },
  };
});

vi.mock("../../components/charts/CategoricalDistributionChart", () => ({
  CategoricalDistributionChart: ({ title }: { title: string }) => (
    <div aria-label={title}>Actor distribution</div>
  ),
}));

vi.mock("../../components/charts/AccessibleChartData", () => ({
  AccessibleChartData: ({ title }: { title: string }) => (
    <div aria-label={`${title} data`}>View data</div>
  ),
}));

vi.mock("../../components/charts/Sparkline", () => ({
  Sparkline: ({ ariaLabel }: { ariaLabel: string }) => (
    <div role="img" aria-label={ariaLabel} />
  ),
}));

import {
  AuditFilters,
  type ActionCategory,
} from "../../components/audit/AuditFilters";
import { AuditInsightsRow } from "../../components/audit/AuditInsightsRow";
import { AuditProofPath } from "../../components/audit/AuditProofPath";
import { AuditRowItem } from "../../components/audit/AuditRowItem";
import {
  AuditSinkDLQTable,
  AuditSinkTable,
} from "../../components/audit/AuditSinkTables";
import {
  RetentionEditor,
  validateAuditRetentionDraft,
} from "../../components/audit/RetentionEditor";
import type {
  AuditRow,
  AuditSink,
  AuditSinkDLQEntry,
  AuditStatsResponse,
  InclusionProofResponse,
  RecentAnomalyRow,
} from "../../lib/api-client";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canConfigureRetention = true;
  mocks.scopesLoading = false;
  mocks.scopesError = null;
  for (const value of Object.values(mocks)) {
    if (typeof value === "function") value.mockReset();
  }
  mocks.getRetention.mockResolvedValue({
    data: { retentionDays: 365, defaultDays: 90 },
  });
  mocks.setRetention.mockResolvedValue({ data: { ok: true } });
  mocks.getAnomalies.mockResolvedValue({ data: { items: [], count: 0 } });
  mocks.replayBulk.mockResolvedValue({
    data: {
      replayed: 1,
      failed: 0,
      skipped: 0,
      entries: [{ id: 4, status: "ok", rows: 3 }],
    },
  });
  mocks.writeClipboard.mockResolvedValue(clipboardSuccess());
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function clearRender(): void {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.replace(/\s+/gu, " ").trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function buttonContaining(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing button containing: ${label}`);
  return match;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

describe("audit governance interaction maturity", () => {
  it("gives every filter a persistent label and every preset an explicit state", async () => {
    const onCategoryChange = vi.fn();
    const onFilterActor = vi.fn();
    const onFilterResource = vi.fn();
    render(
      <>
        <AuditFilters
          actorType="agent"
          actorLabel=""
          actionQuery=""
          resourceType="campaign"
          resourceId="campaign-1"
          days={30}
          category="destructive"
          anomalyType="off_hours"
          onActorTypeChange={vi.fn()}
          onActorLabelChange={vi.fn()}
          onActionQueryChange={vi.fn()}
          onResourceTypeChange={vi.fn()}
          onResourceIdChange={vi.fn()}
          onDaysChange={vi.fn()}
          onCategoryChange={onCategoryChange}
          onAnomalyTypeChange={vi.fn()}
        />
        <div role="table" aria-label="Audit events">
          <AuditRowItem
            row={auditRow()}
            onClick={vi.fn()}
            onFilterActor={onFilterActor}
            onFilterResourceId={onFilterResource}
          />
        </div>
      </>,
    );

    for (const label of [
      "Actor type",
      "Actor label",
      "Action contains",
      "Resource type",
      "Resource ID contains",
    ]) {
      const control = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
          "input, select",
        ),
      ).find((candidate) =>
        document
          .querySelector(`label[for="${candidate.id}"]`)
          ?.textContent?.includes(label),
      );
      expect(control, label).toBeDefined();
    }
    const actorTypeSelect = Array.from(
      document.querySelectorAll<HTMLSelectElement>("select"),
    ).find((candidate) =>
      document
        .querySelector(`label[for="${candidate.id}"]`)
        ?.textContent?.includes("Actor type"),
    );
    expect(
      Array.from(actorTypeSelect?.options ?? []).map((option) => option.value),
    ).toEqual(["any", "human", "agent", "system", "platform_operator"]);
    expect(actorTypeSelect?.textContent).toContain("Human");
    expect(actorTypeSelect?.textContent).not.toContain("User");
    expect(button("Destructive").getAttribute("aria-pressed")).toBe("true");
    expect(button("30d").getAttribute("aria-pressed")).toBe("true");
    expect(buttonContaining("Off-hours").getAttribute("aria-pressed")).toBe(
      "true",
    );
    act(() => button("Export").click());
    expect(onCategoryChange).toHaveBeenCalledWith(
      "export" satisfies ActionCategory,
    );

    act(() => {
      buttonContaining("campaign · campaign").click();
      buttonContaining("Ada Lovelace").click();
    });
    expect(onFilterResource).toHaveBeenCalledWith("campaign-123456789");
    expect(onFilterActor).toHaveBeenCalledWith("Ada Lovelace");
    expect(document.body.textContent).not.toContain("+ Include");
    expect(document.body.textContent).not.toContain("− Exclude");
    expect(document.body.textContent).not.toContain("New network");
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
    expect(seriousViolations(await axe.run(container!))).toEqual([]);
  });

  it("single-flights proof copies and exposes a controlled disclosure", async () => {
    const request = deferred<ReturnType<typeof clipboardSuccess>>();
    mocks.writeClipboard.mockReturnValue(request.promise);
    render(<AuditProofPath proof={inclusionProof()} />);

    const copyLeaf = buttonContaining("aaaabbbbcccc");
    act(() => {
      copyLeaf.click();
      copyLeaf.click();
    });
    expect(mocks.writeClipboard).toHaveBeenCalledTimes(1);
    expect(copyLeaf.disabled).toBe(true);
    expect(copyLeaf.getAttribute("aria-describedby")).toBeTruthy();

    await act(async () => {
      request.resolve(clipboardSuccess());
      await request.promise;
    });
    expect(copyLeaf.textContent).toContain("Copied");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "copied",
    );

    const disclosure = buttonContaining("Show audit path");
    const pathId = disclosure.getAttribute("aria-controls");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    act(() => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(pathId ?? "")).not.toBeNull();
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
    expect(seriousViolations(await axe.run(container!))).toEqual([]);
  });

  it("fails retention closed, validates exact integers, and owns a save from the first click", async () => {
    expect(validateAuditRetentionDraft("12abc").error).toBeTruthy();
    expect(validateAuditRetentionDraft("0").error).toBeTruthy();
    expect(validateAuditRetentionDraft("3650")).toEqual({
      days: 3650,
      error: null,
    });

    const request = deferred<{ data: { ok: boolean } }>();
    mocks.setRetention.mockReturnValue(request.promise);
    render(<RetentionEditor />);
    await settle();
    const input = document.querySelector<HTMLInputElement>(
      "#audit-retention-days",
    );
    expect(input).not.toBeNull();
    setInputValue(input!, "400");
    const apply = button("Apply");
    act(() => {
      apply.click();
      apply.click();
    });
    expect(mocks.setRetention).toHaveBeenCalledTimes(1);
    expect(mocks.setRetention).toHaveBeenCalledWith(400);
    expect(apply.disabled).toBe(true);

    await act(async () => {
      request.resolve({ data: { ok: true } });
      await request.promise;
    });
    expect(document.body.textContent).toContain("Retention set to 400 days");
    mocks.setRetention.mockImplementationOnce(() => {
      throw new Error("retention write exploded");
    });
    act(() => buttonContaining("1 year").click());
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "retention write exploded",
    );

    clearRender();
    mocks.canConfigureRetention = false;
    mocks.setRetention.mockReset();
    render(<RetentionEditor />);
    await settle();
    const restricted = buttonContaining("90 days");
    expect(restricted.disabled).toBe(false);
    expect(restricted.getAttribute("aria-disabled")).toBe("true");
    const describedBy = restricted.getAttribute("aria-describedby") ?? "";
    expect(
      describedBy
        .split(/\s+/u)
        .map((id) => document.getElementById(id)?.textContent)
        .join(" "),
    ).toContain("audit:configure_retention");
    act(() => restricted.click());
    expect(mocks.setRetention).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLInputElement>("#audit-retention-days")
        ?.readOnly,
    ).toBe(true);
    expect(seriousViolations(await axe.run(container!))).toEqual([]);
  });

  it("recovers retention and UEBA reads from thrown requests without claiming an empty state", async () => {
    mocks.getRetention.mockRejectedValueOnce(new Error("retention offline"));
    render(<RetentionEditor />);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "retention offline",
    );
    mocks.getRetention.mockResolvedValueOnce({
      data: { retentionDays: null, defaultDays: 120 },
    });
    act(() => button("Retry").click());
    await settle();
    expect(document.body.textContent).toContain("120d");

    clearRender();
    const filterActor = vi.fn();
    const filterAction = vi.fn();
    mocks.getAnomalies.mockRejectedValueOnce(new Error("UEBA offline"));
    render(
      <AuditInsightsRow
        stats={auditStats()}
        loading={false}
        onFilterActorLabel={filterActor}
        onFilterAction={filterAction}
      />,
    );
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "UEBA offline",
    );
    mocks.getAnomalies.mockResolvedValueOnce({
      data: { items: [anomaly()], count: 1 },
    });
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    await settle();
    expect(mocks.getAnomalies).toHaveBeenCalledTimes(2);
    act(() => {
      buttonContaining("Ada Lovelace").click();
      buttonContaining("campaign.updated").click();
    });
    expect(filterActor).toHaveBeenCalledWith("Ada Lovelace");
    expect(filterAction).toHaveBeenCalledWith("campaign.updated");
    expect(document.body.textContent).toContain("off hours · high · score 91");
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
    expect(seriousViolations(await axe.run(container!))).toEqual([]);
  });

  it("keeps sink mutations single-flight and gives DLQ expansion one semantic button", async () => {
    const toggleRequest = deferred<void>();
    const onToggle = vi.fn(() => toggleRequest.promise);
    render(
      <AuditSinkTable
        rows={[sink()]}
        loading={false}
        canAdmin
        onCreate={vi.fn()}
        onOpen={vi.fn()}
        onToggle={onToggle}
        onResetCircuit={vi.fn(async () => undefined)}
      />,
    );
    const pause = button("Pause");
    act(() => {
      pause.click();
      pause.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(pause.disabled).toBe(true);
    await act(async () => {
      toggleRequest.resolve(undefined);
      await toggleRequest.promise;
    });
    expect(document.body.textContent).toContain(
      "Pause delivery request finished",
    );
    onToggle.mockImplementationOnce(() => {
      throw new Error("toggle exploded");
    });
    act(() => button("Pause").click());
    await settle();
    expect(
      document.querySelector(".audit-sink-action-status[role='alert']")
        ?.textContent,
    ).toContain("toggle exploded");

    clearRender();
    const entryReplay = deferred<void>();
    const onReplay = vi.fn(() => entryReplay.promise);
    render(
      <AuditSinkDLQTable
        entries={[dlqEntry()]}
        loading={false}
        sinksById={new Map([["sink-1", sink()]])}
        canAdmin
        onReplay={onReplay}
        onAfterBulkReplay={vi.fn(async () => undefined)}
      />,
    );
    expect(document.querySelector("tr[role='button']")).toBeNull();
    const disclosure = buttonContaining("Show error details");
    const detailsId = disclosure.getAttribute("aria-controls");
    act(() => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(detailsId ?? "")?.textContent).toContain(
      "upstream refused",
    );

    const replay = button("Replay");
    act(() => {
      replay.click();
      replay.click();
    });
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(replay.disabled).toBe(true);
    await act(async () => {
      entryReplay.resolve(undefined);
      await entryReplay.promise;
    });
    expect(document.body.textContent).toContain(
      "Replay request for DLQ entry 4 finished",
    );

    act(() => button("Replay all").click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("Replay all pending entries?");
    const confirm = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((candidate) => candidate.textContent === "Replay all");
    expect(confirm).toBeDefined();
    act(() => {
      confirm?.click();
      confirm?.click();
    });
    await settle();
    expect(mocks.replayBulk).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Bulk replay: succeeded");
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
    expect(seriousViolations(await axe.run(container!))).toEqual([]);
  });
});

function clipboardSuccess() {
  return {
    ok: true as const,
    backend: "web" as const,
    contentClass: "public" as const,
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: null,
  };
}

function auditRow(): AuditRow {
  return {
    id: "audit-1",
    action: "campaign.updated",
    actorLabel: "Ada Lovelace",
    actorType: "human",
    resourceType: "campaign",
    resourceId: "campaign-123456789",
    ip: "203.0.113.7",
    at: "2026-07-17T08:00:00.000Z",
    redactedFields: ["email"],
  } as AuditRow;
}

function inclusionProof(): InclusionProofResponse {
  return {
    leaf_id: 7,
    leaf_hash: "aaaabbbbccccddddeeeeffff1111222233334444",
    root_hash: "9999888877776666555544443333222211110000",
    audit_path: ["abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd"],
    tree_size: 10,
    root_kid: "key-1",
    anchored_at: "2026-07-17T08:00:00.000Z",
  };
}

function auditStats(): AuditStatsResponse {
  return {
    totalEvents: 12,
    byActorType: [{ label: "human", count: 12 }],
    topActions: [{ label: "campaign.updated", count: 12 }],
    daily: [{ date: "2026-07-17", count: 12 }],
  };
}

function anomaly(): RecentAnomalyRow {
  return {
    auditId: 7,
    score: 91,
    bucket: "high",
    action: "campaign.updated",
    actorLabel: "Ada Lovelace",
    actorType: "human",
    dominantType: "off_hours",
    reasons: [],
    mitreTechniques: [],
    createdAt: "2026-07-17T08:00:00.000Z",
  };
}

function sink(): AuditSink {
  return {
    id: "sink-1",
    kind: "http",
    name: "Security stream",
    enabled: true,
    config: {},
    output_format: "postwave_native",
    webhook_format: "postwave_v1",
    consecutive_failures: 8,
    auto_disable_after: 10,
    circuit_state: "open",
    cooldown_until: "2026-07-17T09:00:00.000Z",
    last_success_at: "2026-07-17T07:00:00.000Z",
  };
}

function dlqEntry(): AuditSinkDLQEntry {
  return {
    id: 4,
    sink_id: "sink-1",
    from_audit_id: 10,
    to_audit_id: 12,
    last_error: "upstream refused the signed batch",
    attempt_count: 3,
    first_failed_at: "2026-07-17T07:00:00.000Z",
    last_attempt_at: "2026-07-17T08:00:00.000Z",
  };
}
