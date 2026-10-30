// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactNode } from "react";
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
  canWrite: false,
  list: vi.fn(),
  listRuns: vi.fn(),
  poll: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  feedSourcesApi: {
    list: mocks.list,
    listRuns: mocks.listRuns,
    poll: mocks.poll,
    remove: mocks.remove,
  },
}));
vi.mock("../../lib/store", () => ({ useCanWrite: () => mocks.canWrite }));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock("../../components/feedsources/FeedSourceFormModal", () => ({
  FeedSourceFormModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Feed source editor" /> : null,
}));
vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children?: ReactNode;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

import { FeedSourcesSection } from "../../components/feedsources/FeedSourcesSection";

const source = {
  id: "feed-1",
  name: "Product blog",
  url: "https://example.com/feed.xml",
  schedule: "daily",
  subject_template: "{{title}}",
  enabled: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canWrite = false;
  for (const key of [
    "list",
    "listRuns",
    "poll",
    "remove",
    "toastError",
    "toastSuccess",
  ] as const) {
    mocks[key].mockReset();
  }
  mocks.list.mockResolvedValue({ data: { items: [source] } });
  mocks.listRuns.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<FeedSourcesSection onOpenCampaign={vi.fn()} />));
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function expand(): Promise<void> {
  act(() => button("Recurring (RSS)").click());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("FeedSourcesSection interaction maturity", () => {
  it("keeps viewer actions discoverable, visible, inert, and axe-clean", async () => {
    render();
    await expand();
    expect(document.body.textContent).toContain("Viewer access is read-only");
    for (const label of ["New feed source", "Poll now", "Edit", "Delete"]) {
      const action = button(label);
      expect(action.disabled).toBe(false);
      expect(action.getAttribute("aria-disabled")).toBe("true");
      expect(action.getAttribute("title")).toBeNull();
      act(() => action.click());
    }
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      container?.querySelectorAll(
        "button[title], input[title], select[title], textarea[title], a[title]",
      ),
    ).toHaveLength(0);
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("single-flights Poll now and reports the honest draft outcome", async () => {
    mocks.canWrite = true;
    let resolvePoll!: (value: unknown) => void;
    mocks.poll.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
    );
    render();
    await expand();
    const poll = button("Poll now");
    act(() => {
      poll.click();
      poll.click();
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);
    expect(button("Polling…").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      resolvePoll({
        data: {
          run_id: "run-1",
          status: "ok",
          items_seen: 3,
          new_items: 1,
          campaign_id: "campaign-1",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("draft campaign");
    expect(button("Dismiss")).toBeTruthy();
  });
});
