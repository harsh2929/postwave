// @vitest-environment happy-dom

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

import {
  CampaignOptionsProvider,
  CampaignSelect,
} from "../../components/deliverability/CampaignSelect";

const mocks = vi.hoisted(() => ({
  listCampaigns: vi.fn(),
  onChange: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { listCampaigns: mocks.listCampaigns },
}));

vi.mock("../../lib/store", () => ({
  useMe: () => ({ tenant: "tenant-1" }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.listCampaigns.mockReset();
  mocks.onChange.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function renderPicker(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CampaignOptionsProvider>
        <CampaignSelect
          id="campaign-a"
          ariaLabel="Campaign A"
          value=""
          onChange={mocks.onChange}
        />
        <CampaignSelect
          id="campaign-b"
          ariaLabel="Campaign B"
          value=""
          onChange={mocks.onChange}
        />
      </CampaignOptionsProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("shared deliverability campaign picker", () => {
  it("loads the canonical campaign array once for every diagnostic card", async () => {
    mocks.listCampaigns.mockResolvedValue({
      data: [{ id: "campaign-1", name: "Launch", status: "sent" }],
    });

    await renderPicker();

    expect(mocks.listCampaigns).toHaveBeenCalledTimes(1);
    expect(
      document.querySelectorAll('option[value="campaign-1"]'),
    ).toHaveLength(2);
    expect(document.body.textContent).toContain("Launch · sent");
  });

  it("offers a retry and a validated direct-id path when listing fails", async () => {
    mocks.listCampaigns
      .mockResolvedValueOnce({ error: { message: "secret remote failure" } })
      .mockResolvedValueOnce({ data: [] });

    await renderPicker();

    expect(document.body.textContent).not.toContain("secret remote failure");
    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listCampaigns).toHaveBeenCalledTimes(2);

    const direct = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Use campaign ID"),
    );
    act(() => direct?.click());
    const input =
      document.querySelector<HTMLInputElement>("#campaign-a-direct");
    expect(input).not.toBeNull();
    act(() => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "older_campaign-42");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const form = input?.closest("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(mocks.onChange).toHaveBeenCalledWith("older_campaign-42");
  });
});
