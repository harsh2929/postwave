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
  retryEvents: vi.fn(),
  markReady: vi.fn(),
  dismiss: vi.fn(),
  groupList: vi.fn(),
  groupReport: vi.fn(),
  groupCreate: vi.fn(),
  groupUpdate: vi.fn(),
  groupRemove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  canWrite: vi.fn(),
  canAdmin: vi.fn(),
  roleStatus: vi.fn(),
  me: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  intelligentRetryApi: {
    events: mocks.retryEvents,
    markReady: mocks.markReady,
    dismiss: mocks.dismiss,
  },
  controlGroupsApi: {
    list: mocks.groupList,
    report: mocks.groupReport,
    create: mocks.groupCreate,
    update: mocks.groupUpdate,
    remove: mocks.groupRemove,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: mocks.canAdmin,
  useRoleStatus: mocks.roleStatus,
  useMe: mocks.me,
  useCanWrite: mocks.canWrite,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { IntelligentRetryCard } from "../../components/deliverability/IntelligentRetryCard";
import { ControlGroupsCard } from "../../components/experiments/ControlGroupsCard";
import { EventCatalog } from "../../components/track/EventCatalog";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.canWrite.mockReturnValue(true);
  mocks.canAdmin.mockReturnValue(true);
  mocks.roleStatus.mockReturnValue("resolved");
  mocks.me.mockReturnValue({ tenant: "tenant-1", user: "user-1" });
  mocks.retryEvents.mockResolvedValue({
    data: {
      items: [
        {
          id: "retry-1",
          tenant_id: "tenant-1",
          campaign_id: "campaign-1",
          subscriber_email: "reader@example.test",
          reason: "frequency_cap",
          status: "pending",
          retry_after: "2026-07-16T12:00:00Z",
          attempts: 1,
          created_at: "2026-07-16T10:00:00Z",
          updated_at: "2026-07-16T10:00:00Z",
        },
      ],
    },
  });
  mocks.groupList.mockResolvedValue({
    data: {
      items: [
        {
          id: "group-1",
          tenant_id: "tenant-1",
          name: "Global holdback",
          description: "Five percent measurement cohort",
          percent: 5,
          seed: "seed",
          status: "active",
          starts_at: "2026-07-01T00:00:00Z",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-01T00:00:00Z",
        },
      ],
    },
  });
  mocks.groupReport.mockResolvedValue({
    data: {
      group_id: "group-1",
      window_days: 30,
      enforced: false,
      warning:
        "Incremental lift is unavailable because this cohort is not excluded at send time.",
      control_size: 50,
      treated_size: 950,
      generated_at: "2026-07-16T12:00:00Z",
    },
  });
  mocks.groupCreate.mockResolvedValue({
    data: {
      id: "group-2",
      tenant_id: "tenant-1",
      name: "Launch holdback",
      description: "Launch measurement cohort",
      percent: 5,
      seed: "seed-2",
      status: "active",
      starts_at: "2026-07-16T00:00:00Z",
      created_at: "2026-07-16T00:00:00Z",
      updated_at: "2026-07-16T00:00:00Z",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function buttonContaining(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`Expected button containing: ${label}`);
  return found;
}

function buttonExact(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected exact button: ${label}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DUX-024 qualified-table contained wave behavior", () => {
  it("retains a verified Event Catalog during refresh and uses an explicit cell action", () => {
    const onPick = vi.fn();
    render(
      <EventCatalog
        items={[
          {
            eventName: "purchase.completed",
            count: 42,
            uniqueSubscribers: 19,
            firstSeen: "2026-07-01T00:00:00Z",
            lastSeen: "2026-07-16T00:00:00Z",
            daily: [
              { date: "2026-07-15", count: 18 },
              { date: "2026-07-16", count: 24 },
            ],
          },
        ]}
        loading
        selectedEvent=""
        onPick={onPick}
      />,
    );

    expect(document.querySelector("table")).not.toBeNull();
    expect(document.querySelector("caption")?.textContent).toBe(
      "Event catalog",
    );
    expect(document.querySelector("tr[role='button']")).toBeNull();
    expect(document.body.textContent).toContain("purchase.completed");
    expect(document.body.textContent).toContain(
      "Refreshing · showing the last verified event catalog",
    );

    act(() => buttonContaining("Filter").click());
    expect(onPick).toHaveBeenCalledWith("purchase.completed");
  });

  it("retains the last verified retry rows when refresh fails", async () => {
    render(<IntelligentRetryCard />);
    await flush();
    expect(document.body.textContent).toContain("r•••••@example.test");
    expect(document.body.textContent).not.toContain("reader@example.test");
    expect(document.querySelector("table")).not.toBeNull();

    mocks.retryEvents.mockResolvedValueOnce({
      error: { message: "network unavailable" },
    });
    act(() => buttonContaining("Refresh").click());
    await flush();

    expect(document.body.textContent).toContain(
      "Retry evidence could not be verified. The last verified queue remains visible.",
    );
    expect(document.body.textContent).not.toContain("network unavailable");
    expect(document.body.textContent).toContain("r•••••@example.test");
    expect(document.body.textContent).not.toContain("reader@example.test");
    expect(document.querySelector("table")).not.toBeNull();
  });

  it("withholds exact-admin retry evidence from a viewer without dispatching a read", async () => {
    mocks.canAdmin.mockReturnValue(false);

    render(<IntelligentRetryCard />);
    await flush();

    expect(mocks.retryEvents).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Workspace owner or admin access is required",
    );
    expect(document.querySelector("table")).toBeNull();
    expect(document.body.textContent).not.toContain("reader@example.test");
  });

  it("exposes a control-group report as a labelled expanded table region", async () => {
    render(<ControlGroupsCard />);
    act(() => buttonContaining("Control groups").click());
    await flush();

    expect(document.querySelector("table")).not.toBeNull();
    expect(document.body.textContent).toContain("Global holdback");
    act(() => buttonContaining("Report").click());
    await flush();

    const reportRegion = Array.from(
      document.querySelectorAll<HTMLElement>("[role='region']"),
    ).find(
      (region) =>
        region.getAttribute("aria-label") === "Lift report for Global holdback",
    );
    expect(reportRegion).toBeTruthy();
    expect(reportRegion?.textContent).toContain("Incremental lift");
    expect(mocks.groupReport).toHaveBeenCalledWith("group-1", 30);
  });

  it("makes unenforced control-group mutations natively unavailable and axe-clean", async () => {
    mocks.canWrite.mockReturnValue(false);
    render(<ControlGroupsCard />);
    act(() => buttonContaining("Control groups").click());
    await flush();

    const create = buttonExact("New control group");
    const edit = buttonExact("Edit");
    const remove = buttonExact("Delete");
    for (const action of [create, edit, remove]) {
      expect(action.disabled).toBe(true);
      expect(action.getAttribute("aria-disabled")).toBe("true");
    }
    expect(document.body.textContent).toContain(
      "Control groups are reporting-only",
    );
    expect(document.body.textContent).toContain(
      "Dispatch does not currently exclude these cohorts",
    );
    expect(document.body.textContent).toContain(
      "Five percent measurement cohort",
    );
    expect(document.querySelector("[title]")).toBeNull();

    act(() => {
      create.click();
      edit.click();
      remove.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const result = await axe.run(container ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("blocks editor creation while dispatch enforcement is absent", async () => {
    render(<ControlGroupsCard />);
    act(() => buttonContaining("Control groups").click());
    await flush();
    const create = buttonExact("New control group");
    expect(create.disabled).toBe(true);
    act(() => create.click());
    expect(document.querySelector("#cg-name")).toBeNull();
    expect(mocks.groupCreate).not.toHaveBeenCalled();
  });

  it("surfaces a synchronous list failure and same-tick-safe retry", async () => {
    mocks.groupList.mockImplementationOnce(() => {
      throw new Error("control-group service offline");
    });
    render(<ControlGroupsCard />);
    act(() => buttonContaining("Control groups").click());
    await flush();
    expect(document.body.textContent).toContain(
      "Moosewave couldn't load control groups",
    );
    const retry = buttonExact("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    await flush();
    expect(mocks.groupList).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Global holdback");
  });
});
