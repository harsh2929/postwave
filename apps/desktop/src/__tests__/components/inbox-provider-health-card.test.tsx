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

const mocks = vi.hoisted(() => ({
  listSubscribers: vi.fn(),
  listSuppressions: vi.fn(),
  setSection: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { listSubscribers: mocks.listSubscribers },
  suppressionsApi: { list: mocks.listSuppressions },
}));

vi.mock("../../lib/store", () => ({ setSection: mocks.setSection }));

vi.mock("../../components/InlineHelp", () => ({
  InlineHelp: ({ text }: { text: string }) => (
    <span className="inline-help-test">{text}</span>
  ),
}));

import { InboxProviderHealthCard } from "../../components/analytics/InboxProviderHealthCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSubscribers.mockResolvedValue({
    data: {
      items: [
        { id: "sub-1", email: "one@gmail.com" },
        { id: "sub-2", email: "two@googlemail.com" },
        { id: "sub-3", email: "three@yahoo.com" },
      ],
    },
  });
  mocks.listSuppressions.mockImplementation(({ reason }: { reason: string }) =>
    Promise.resolve({
      data: {
        items:
          reason === "hard_bounce"
            ? [{ id: "supp-1", email: "bounce@gmail.com" }]
            : [{ id: "supp-2", email: "complaint@yahoo.com" }],
      },
    }),
  );
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
  act(() =>
    root?.render(<InboxProviderHealthCard windowLabel="Last 30 days" />),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("InboxProviderHealthCard", () => {
  it("renders an honest semantic sample with all definitions directly visible", async () => {
    render();
    await flush();

    const table = document.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.querySelector("caption")?.textContent).toContain(
      "Inbox provider audience and suppression sample",
    );
    expect(document.body.textContent).toContain(
      "2 subscribers · 66.7% of sampled audience",
    );
    expect(document.body.textContent).toContain(
      "sampled hard-bounce suppressions",
    );
    expect(document.body.textContent).toContain(
      "sampled complaint suppressions",
    );
    expect(document.body.textContent).toContain(
      "Recipient-keyed feed not available",
    );
    expect(document.body.textContent).not.toContain("Last 30 days");
    expect(container?.querySelector("[title]")).toBeNull();

    act(() => button("Open Deliverability Hub →").click());
    expect(mocks.setSection).toHaveBeenCalledWith("deliverabilityHub");

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains synchronous failures, hides raw details, and single-flights retry", async () => {
    mocks.listSubscribers
      .mockImplementationOnce(() => {
        throw new Error("private database host detail");
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: "sub-retry", email: "retry@gmail.com" }] },
      });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain(
      "private database host detail",
    );
    const retry = button("Retry provider split");
    await act(async () => {
      retry.click();
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listSubscribers).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "1 subscriber · 100.0% of sampled audience",
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
