// @vitest-environment happy-dom

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
  listCampaigns: vi.fn(),
  previewSchedule: vi.fn(),
  schedule: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    apiSendTimeAssets: {
      ...actual.apiSendTimeAssets,
      listCampaigns: mocks.listCampaigns,
      previewScheduleByBestTime: mocks.previewSchedule,
      scheduleCampaignByBestTime: mocks.schedule,
    },
  };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import {
  CampaignScheduleCard,
  useSendTimeCampaignScheduling,
} from "../../pages/SendTime";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useSendTimeCampaignScheduling> | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCampaigns.mockResolvedValue({ data: [] });
  mocks.previewSchedule.mockResolvedValue({ data: null });
  mocks.schedule.mockResolvedValue({
    data: { campaign_id: "campaign-1", scheduled: 1, persisted: true },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
});

function Harness(): ReactElement {
  const controller = useSendTimeCampaignScheduling(true);
  latest = controller;
  return <CampaignScheduleCard controller={controller} stoEnabled />;
}

describe("send-time campaign scheduling containment", () => {
  it("renders the route action honestly unavailable without loading candidates", async () => {
    render(<Harness />);
    await settle();

    expect(document.body.textContent).toContain(
      "durable delivery and recovery are being verified",
    );
    expect(mocks.listCampaigns).not.toHaveBeenCalled();
    expect(
      document.querySelectorAll(
        "select, input[type='radio'], input[type='datetime-local']",
      ),
    ).toHaveLength(0);
    expect(document.body.textContent).toContain("Delivery changes stay locked");
    expect(document.body.textContent).toContain("Review campaign drafts");
  });

  it("fails closed when a caller invokes the hidden scheduling handler directly", async () => {
    render(<Harness />);
    await settle();
    act(() => latest?.setCampaignId("campaign-1"));

    await act(async () => latest?.submitSchedule());

    expect(mocks.previewSchedule).not.toHaveBeenCalled();
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(latest?.scheduleErr).toContain(
      "Scheduling is temporarily unavailable",
    );
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Scheduling is temporarily unavailable"),
    );
  });
});

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

async function settle(turns = 5): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => Promise.resolve());
  }
}
