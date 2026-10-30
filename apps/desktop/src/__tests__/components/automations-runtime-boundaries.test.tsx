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
  list: vi.fn(),
  pollNow: vi.fn(),
  fires: vi.fn(),
  getAlerts: vi.fn(),
  listDLQ: vi.fn(),
  remove: vi.fn(),
  validate: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  catalog: vi.fn(),
  listCampaigns: vi.fn(),
  getCampaign: vi.fn(),
  createCampaign: vi.fn(),
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../lib/api-client", () => ({
  zeroCopyTriggersApi: {
    list: mocks.list,
    pollNow: mocks.pollNow,
    fires: mocks.fires,
    getAlerts: mocks.getAlerts,
    listDLQ: mocks.listDLQ,
    remove: mocks.remove,
    validate: mocks.validate,
    create: mocks.create,
    update: mocks.update,
  },
  omnichannelApi: {
    catalog: mocks.catalog,
    listCampaigns: mocks.listCampaigns,
    getCampaign: mocks.getCampaign,
    createCampaign: mocks.createCampaign,
  },
}));

import { OmnichannelSection } from "../../components/automations/OmnichannelSection";
import { TriggerDetailSlideover } from "../../components/automations/TriggerDetailSlideover";
import { ZeroCopyTriggersSection } from "../../components/automations/ZeroCopyTriggersSection";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const NOW = "2026-07-21T10:00:00.000Z";
const ZERO_COPY_RUNTIME = {
  capability: "zero_copy_trigger_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "zero_copy_runtime_unavailable",
  message: "Zero-copy execution is unavailable.",
  prerequisites: ["durable_execution_receipts"],
};
const TRIGGER = {
  id: "trigger-1",
  name: "Recent orders",
  status: "draft",
  provider: "snowflake",
  query: "SELECT email, created_at FROM orders WHERE created_at > :cursor",
  cursor_column: "created_at",
  profile_key_column: "email",
  polling_interval_seconds: 300,
  max_rows_per_tick: 500,
  consecutive_failures: 0,
  rows_fired_total: 1,
  last_polled_at: NOW,
  runtime: ZERO_COPY_RUNTIME,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({ data: { items: [TRIGGER] } });
  mocks.fires.mockResolvedValue({
    data: {
      items: [
        {
          id: 1,
          trigger_id: "trigger-1",
          status: "fired",
          fired_at: NOW,
          has_cursor: true,
          has_profile_key: true,
          has_subscriber: true,
          has_payload: true,
          has_flow_run: false,
          error_category: "execution_error",
          payload: { email: "customer@example.test" },
          error: "provider token secret",
        },
      ],
    },
  });
  mocks.getAlerts.mockResolvedValue({
    data: {
      trigger_id: "trigger-1",
      runtime: ZERO_COPY_RUNTIME,
      consecutive_failures_threshold: 5,
      lag_seconds_threshold: 900,
      fires_per_tick_threshold: 0,
      webhook_configured: false,
      cooldown_seconds: 1_800,
      has_last_alert_message: false,
    },
  });
  mocks.listDLQ.mockResolvedValue({
    data: {
      items: [
        {
          id: 8,
          trigger_id: "trigger-1",
          reason: "unresolved_subscriber",
          retry_count: 0,
          status: "pending",
          created_at: NOW,
          updated_at: NOW,
          has_cursor: true,
          has_profile_key: true,
          has_payload: true,
        },
      ],
    },
  });
  mocks.catalog.mockResolvedValue({
    data: {
      schema_version: "1",
      channels: [
        {
          key: "email",
          label: "Email",
          runtime_status: "available",
          fields: [],
        },
      ],
      send_strategies: [
        { key: "ordered", label: "Ordered", runtime_status: "declared" },
      ],
      recipient_snapshot_modes: [
        { key: "frozen", label: "Frozen", runtime_status: "declared" },
      ],
      path_statuses: ["draft"],
    },
  });
  mocks.listCampaigns.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("warehouse definition authority and runtime boundaries", () => {
  it("does not request or reveal admin-only definitions for a viewer", async () => {
    render(<ZeroCopyTriggersSection canAdmin={false} />);
    await flush();

    expect(mocks.list).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Admin access required");
    expect(document.body.textContent).not.toContain(TRIGGER.query);
    expect(document.querySelector("select")).toBeNull();
  });

  it("clears sensitive definition data immediately when an admin role is downgraded", async () => {
    render(<ZeroCopyTriggersSection canAdmin />);
    await flush();
    expect(document.body.textContent).toContain("Recent orders");
    expect(mocks.list).toHaveBeenCalledTimes(1);

    act(() => root?.render(<ZeroCopyTriggersSection canAdmin={false} />));
    await flush();

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Admin access required");
    expect(document.body.textContent).not.toContain("Recent orders");
    expect(document.body.textContent).not.toContain(TRIGGER.query);
  });

  it("closes admin-only overlays immediately on role downgrade", async () => {
    render(<ZeroCopyTriggersSection canAdmin />);
    await flush();

    act(() => button("+ New trigger draft").click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => root?.render(<ZeroCopyTriggersSection canAdmin={false} />));
    await flush();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("Admin access required");
  });

  it("does not reconcile or toast after authority changes during deletion", async () => {
    let resolveDelete!: (value: unknown) => void;
    mocks.remove.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
    );
    render(<ZeroCopyTriggersSection canAdmin />);
    await flush();

    act(() => button("Delete").click());
    act(() => button("Delete definition").click());
    expect(mocks.remove).toHaveBeenCalledWith("trigger-1");

    act(() => root?.render(<ZeroCopyTriggersSection canAdmin={false} />));
    await act(async () => {
      resolveDelete({ data: undefined });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Admin access required");
  });

  it("loads cursor pages without replacing already verified definitions", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: { items: [TRIGGER], nextCursor: "cursor_2" },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{ ...TRIGGER, id: "trigger-2", name: "Second draft" }],
        },
      });
    render(<ZeroCopyTriggersSection canAdmin />);
    await flush();

    act(() => button("Load more definitions").click());
    await flush();

    expect(mocks.list).toHaveBeenNthCalledWith(1, { limit: 200 });
    expect(mocks.list).toHaveBeenNthCalledWith(2, {
      cursor: "cursor_2",
      limit: 200,
    });
    expect(document.body.textContent).toContain("Recent orders");
    expect(document.body.textContent).toContain("Second draft");
    expect(document.body.textContent).toContain("2 definitions loaded");
  });

  it("retains verified rows when the next page overlaps existing identities", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: { items: [TRIGGER], nextCursor: "cursor_2" },
      })
      .mockResolvedValueOnce({ data: { items: [TRIGGER] } });
    render(<ZeroCopyTriggersSection canAdmin />);
    await flush();

    act(() => button("Load more definitions").click());
    await flush();

    expect(document.body.textContent).toContain("Recent orders");
    expect(document.body.textContent).toContain(
      "Showing the last loaded trigger definitions",
    );
    expect(document.body.textContent).toContain("Load more failed");
  });

  it("keeps live polling inert even when the unavailable control is invoked", async () => {
    render(<ZeroCopyTriggersSection canAdmin />);
    await flush();

    act(() => button("Poll unavailable").click());
    expect(mocks.pollNow).not.toHaveBeenCalled();
    expect(button("Poll unavailable").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("fails closed on malformed list data rather than claiming an empty state", async () => {
    mocks.list.mockResolvedValueOnce({
      data: { items: [{ ...TRIGGER, rows_fired_total: -1 }] },
    });
    render(<ZeroCopyTriggersSection canAdmin />);
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Trigger definitions are unavailable",
    );
    expect(document.body.textContent).not.toContain(
      "Start with an inert, reviewable definition",
    );
  });

  it("retains previously verified rows when refresh fails", async () => {
    render(<ZeroCopyTriggersSection canAdmin />);
    await flush();
    expect(document.body.textContent).toContain("Recent orders");

    mocks.list.mockResolvedValueOnce({
      error: { message: "customer@example.test token=secret" },
    });
    act(() => button("Refresh").click());
    await flush();

    expect(document.body.textContent).toContain("Recent orders");
    expect(document.body.textContent).toContain(
      "Showing the last loaded trigger definitions",
    );
    expect(document.body.textContent).not.toContain("customer@example.test");
    expect(document.body.textContent).not.toContain("token=secret");
  });
});

describe("redacted execution inspection", () => {
  it("renders only final safe DTO evidence and withholds legacy raw fields", async () => {
    render(
      <TriggerDetailSlideover
        trigger={TRIGGER}
        canAdmin
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await flush();

    expect(document.body.textContent).toContain(
      "cursor, profile key, subscriber, payload",
    );
    expect(document.body.textContent).toContain(
      "Execution error recorded · details hidden",
    );
    expect(document.body.textContent).not.toContain("customer@example.test");
    expect(document.body.textContent).not.toContain("provider token secret");
    expect(
      document
        .querySelector('[role="region"][aria-label="Trigger enqueue records"]')
        ?.getAttribute("tabindex"),
    ).toBe("0");
  });

  it("rejects malformed successful detail data without crashing", async () => {
    mocks.fires.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: 1,
            trigger_id: "trigger-1",
            status: "fired",
            fired_at: NOW,
          },
        ],
      },
    });
    render(
      <TriggerDetailSlideover
        trigger={TRIGGER}
        canAdmin
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Enqueue records are unavailable",
    );
    expect(document.body.textContent).not.toContain("No enqueue records");
  });

  it("links inert alert and recovery controls to explicit unavailable reasons", async () => {
    render(
      <TriggerDetailSlideover
        trigger={TRIGGER}
        canAdmin
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await flush();

    act(() => button("Alert config").click());
    await flush();
    const save = button("Saving unavailable");
    const alertReason = save.getAttribute("aria-describedby");
    expect(alertReason).toBeTruthy();
    expect(document.getElementById(alertReason ?? "")?.textContent).toContain(
      "Effective defaults or stored thresholds",
    );
    expect(document.getElementById(alertReason ?? "")?.textContent).toContain(
      "persistence is not exposed",
    );

    act(() => button("Recovery").click());
    await flush();
    const retry = button("Retry unavailable");
    const recoveryReason = retry.getAttribute("aria-describedby");
    expect(recoveryReason).toBeTruthy();
    expect(
      document.getElementById(recoveryReason ?? "")?.textContent,
    ).toContain("Recovery is not operational");
    expect(mocks.listDLQ).toHaveBeenCalledTimes(1);
  });

  it("has no serious or critical automated accessibility violations", async () => {
    render(<ZeroCopyTriggersSection canAdmin={false} />);
    await flush();
    const result = await axe.run(container ?? document.body, {
      rules: {
        region: { enabled: false },
        "color-contrast": { enabled: false },
      },
    });
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      ),
    ).toEqual([]);
  });
});

describe("omnichannel definition containment", () => {
  it("keeps creation inert and labels catalog entries as declarations, not tenant readiness", async () => {
    render(<OmnichannelSection canAdmin />);
    await flush();

    expect(document.body.textContent).toContain("Declared: available");
    expect(document.body.textContent).toContain("Tenant runtime not checked");
    const create = button("New campaign unavailable");
    expect(create.getAttribute("aria-disabled")).toBe("true");
    act(() => create.click());
    expect(mocks.createCampaign).not.toHaveBeenCalled();
  });

  it("fails closed for duplicate catalog identities", async () => {
    const duplicate = {
      key: "email",
      label: "Email",
      runtime_status: "available",
      fields: [],
    };
    mocks.catalog.mockResolvedValueOnce({
      data: {
        schema_version: "1",
        channels: [duplicate, duplicate],
        send_strategies: [],
        recipient_snapshot_modes: [],
        path_statuses: ["draft"],
      },
    });
    render(<OmnichannelSection canAdmin />);
    await flush();

    expect(document.body.textContent).toContain(
      "Channel schema is unavailable",
    );
    expect(document.body.textContent).not.toContain(
      "No channel types declared",
    );
  });
});
