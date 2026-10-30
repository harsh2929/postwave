// @vitest-environment happy-dom

import { act, useState } from "react";
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

import type { CampaignDetail } from "../../lib/api-client";
import {
  type CampaignScheduleController,
  useCampaignScheduleController,
} from "../../components/campaigns/useCampaignScheduleController";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  patchPsto: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../lib/campaign-operational-availability", () => ({
  CAMPAIGN_SCHEDULING_AVAILABLE: true,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON: "",
}));
vi.mock("../../lib/api-client", () => ({
  api: {
    scheduleCampaign: mocks.schedule,
    patchCampaignPSTO: mocks.patchPsto,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
  },
}));
vi.mock("../../lib/telemetry", () => ({ track: vi.fn() }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let controller: CampaignScheduleController;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.schedule.mockResolvedValue({
    data: { id: "campaign-1", status: "scheduled" },
  });
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  resetLifecycleCoordinatorForTests();
});

describe("desktop campaign poll schedule preflight", () => {
  it("does not submit a schedule when exact poll preparation fails", async () => {
    const beforeSchedule = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("exact poll receipt unresolved"));
    renderHarness(beforeSchedule);
    act(() => controller.setScheduleAt(futureTime()));

    await act(async () => controller.schedule());

    expect(beforeSchedule).toHaveBeenCalledOnce();
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("exact poll receipt unresolved"),
    );
  });

  it("awaits poll preparation before submitting the schedule", async () => {
    const order: string[] = [];
    const beforeSchedule = vi.fn(async () => {
      order.push("polls-ready");
    });
    mocks.schedule.mockImplementation(async () => {
      order.push("schedule");
      return { data: { id: "campaign-1", status: "scheduled" } };
    });
    renderHarness(beforeSchedule);
    act(() => controller.setScheduleAt(futureTime()));

    await act(async () => controller.schedule());

    expect(order).toEqual(["polls-ready", "schedule"]);
  });
});

function renderHarness(beforeSchedule: () => Promise<void>): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness beforeSchedule={beforeSchedule} />));
}

function Harness({
  beforeSchedule,
}: {
  beforeSchedule: () => Promise<void>;
}): null {
  const [detail, setDetail] = useState<CampaignDetail>({
    id: "campaign-1",
    name: "Launch",
    status: "draft",
  } as CampaignDetail);
  const [, setBusy] = useState(false);
  controller = useCampaignScheduleController({
    id: detail.id,
    detail,
    setDetail,
    setBusy,
    beforeSchedule,
  });
  return null;
}

function futureTime(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}
