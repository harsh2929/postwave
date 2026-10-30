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
  createRun: vi.fn(),
  getRun: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  contentOptimizerApi: {
    createRun: mocks.createRun,
    get: mocks.getRun,
    preview: mocks.preview,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { ReplyQuotePicker } from "../../components/ReplyQuotePicker";
import { ContentOptimizerCard } from "../../components/composer/ContentOptimizerCard";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRun.mockResolvedValue({
    error: { status: 404, message: "No optimizer run" },
  });
  mocks.preview.mockResolvedValue({
    data: {
      method: "preview",
      primary_metric: "opens",
      recommended_arms: [],
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

describe("campaign advanced-feature containment", () => {
  it("does not load or expose private replies for publication", () => {
    const onClose = vi.fn();
    const onPick = vi.fn();
    render(
      <ReplyQuotePicker
        open
        campaignId="campaign-1"
        onClose={onClose}
        onPick={onPick}
      />,
    );

    expect(document.body.textContent).toContain(
      "Reader quotes require consent",
    );
    expect(document.body.textContent).toContain(
      "No reply content or sender address is loaded",
    );
    expect(document.body.textContent).not.toContain("Quote a reader reply");
    expect(document.body.textContent).not.toContain("from_email");
    expect(onPick).not.toHaveBeenCalled();
    act(() => button("Understood").click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("allows allocation preview but natively blocks persisted optimizer activation", async () => {
    render(<ContentOptimizerCard campaignId="campaign-1" canMutate />);
    await flush();

    expect(button("Preview allocation").disabled).toBe(false);
    const activate = button("Activation unavailable");
    expect(activate.disabled).toBe(true);
    expect(activate.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("not applied at send yet");
    act(() => activate.click());
    expect(mocks.createRun).not.toHaveBeenCalled();
  });
});
