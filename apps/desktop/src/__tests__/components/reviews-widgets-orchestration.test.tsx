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

import type { ReviewWidget } from "../../lib/api/reviews";

const mocks = vi.hoisted(() => ({
  listWidgets: vi.fn(),
  widgetCardProps: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  reviewsApi: {
    listWidgets: mocks.listWidgets,
  },
}));

vi.mock("../../components/Icon", () => ({
  Icon: ({ name }: { name: string }) => (
    <span aria-hidden="true" data-test-icon={name} />
  ),
}));

vi.mock("../../components/reviews/WidgetCard", () => ({
  WidgetCard: ({ widget }: { widget: ReviewWidget }) => {
    mocks.widgetCardProps(widget);
    return (
      <article
        data-testid="widget-boundary"
        data-widget-id={widget.id}
        data-widget-status={widget.status}
      >
        {widget.name}
      </article>
    );
  },
}));

import { WidgetsTab } from "../../components/reviews/WidgetsTab";

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
  mocks.listWidgets.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function wireWidget(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "widget-1",
    slug: "homepage-reviews",
    name: "Homepage reviews",
    status: "active",
    widget_type: "product_reviews",
    language: "en",
    public_url: "https://reviews.example.test/homepage-reviews",
    updated_at: "2026-07-29T08:30:00.000Z",
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof WidgetsTab>[0]> = {}): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const node: ReactElement = (
    <WidgetsTab
      widgetTypes={["summary", "product_reviews"]}
      canAdmin
      {...props}
    />
  );
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function normalizedText(node: Element | null): string {
  return node?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function buttonNamed(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => normalizedText(candidate) === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function lifecycleButton(label: string): HTMLButtonElement {
  const group = document.querySelector(
    '[role="group"][aria-label="Filter widgets by lifecycle state"]',
  );
  const match = Array.from(
    group?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((candidate) => normalizedText(candidate) === label);
  if (!match) throw new Error(`Missing lifecycle filter: ${label}`);
  return match;
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.bind(input);
  act(() => {
    setter?.(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function visibleWidgetNames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="widget-boundary"]'),
  ).map(normalizedText);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Reviews widget-list orchestration", () => {
  it("withholds one-shot widget authoring for administrators and viewers", async () => {
    mocks.listWidgets.mockResolvedValue({
      data: { items: [wireWidget()] },
    });
    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Widget authoring is review-gated");
    expect(text).toContain("including active");
    expect(text).toContain("no later edit or transition command");
    expect(text).toContain("immediate, unreviewed publication");
    expect(text).toContain("administrator can monitor the inventory");
    expect(
      Array.from(document.querySelectorAll("button")).some((button) =>
        /\bCreate\b/u.test(normalizedText(button)),
      ),
    ).toBe(false);

    act(() => root?.unmount());
    root = createRoot(container!);
    mocks.listWidgets.mockResolvedValueOnce({
      data: { items: [wireWidget()] },
    });
    act(() =>
      root?.render(
        <WidgetsTab widgetTypes={["product_reviews"]} canAdmin={false} />,
      ),
    );
    await flush();
    expect(document.body.textContent).toContain(
      "Your current role is read-only.",
    );
  });

  it("summarizes, orders, searches, and filters exact lifecycle truth", async () => {
    mocks.listWidgets.mockResolvedValue({
      data: {
        items: [
          wireWidget({
            id: "paused",
            name: "Gamma paused",
            slug: "gamma",
            status: "paused",
          }),
          wireWidget({
            id: "draft",
            name: "Beta draft",
            slug: "beta",
            status: "draft",
          }),
          wireWidget({
            id: "active",
            name: "Alpha active",
            slug: "alpha",
            status: "active",
          }),
          wireWidget({
            id: "future",
            name: "Future exact",
            slug: "future-slug",
            status: "scheduled_future",
          }),
        ],
      },
    });
    render();
    await flush();

    expect(visibleWidgetNames()).toEqual([
      "Future exact",
      "Alpha active",
      "Beta draft",
      "Gamma paused",
    ]);
    const summary = document.querySelector(
      '[aria-label="Loaded widget states"]',
    );
    expect(
      Array.from(summary?.children ?? []).map((item) => ({
        count: item.querySelector("strong")?.textContent,
        label: item.querySelector("small")?.textContent,
      })),
    ).toEqual([
      { count: "1", label: "Active" },
      { count: "1", label: "Draft" },
      { count: "1", label: "Paused" },
    ]);
    expect(lifecycleButton("scheduled_future 1")).toBeTruthy();

    act(() => lifecycleButton("Draft 1").click());
    expect(visibleWidgetNames()).toEqual(["Beta draft"]);
    expect(lifecycleButton("Draft 1").getAttribute("aria-pressed")).toBe(
      "true",
    );

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    if (!search) throw new Error("Missing widget search");
    setInput(search, "no-match");
    expect(document.body.textContent).toContain("No widgets match this view");

    act(() => buttonNamed("Reset view").click());
    expect(visibleWidgetNames()).toEqual([
      "Future exact",
      "Alpha active",
      "Beta draft",
      "Gamma paused",
    ]);
    expect(lifecycleButton("All 4").getAttribute("aria-pressed")).toBe("true");

    setInput(search, "future-slug");
    expect(visibleWidgetNames()).toEqual(["Future exact"]);
  });

  it("fails malformed envelopes closed and never reports them as empty inventory", async () => {
    mocks.listWidgets.mockResolvedValue({
      data: { items: "not-an-array" },
    });
    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("The widget inventory could not be verified");
    expect(text).toContain("The server could not verify this data.");
    expect(text).not.toContain("No widget records were returned");
  });

  it("withholds malformed records while rendering verified widget rows", async () => {
    mocks.listWidgets.mockResolvedValue({
      data: {
        items: [
          wireWidget(),
          wireWidget({ id: "", name: "Missing identity" }),
          wireWidget({ id: "missing-type", widget_type: undefined }),
        ],
      },
    });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "2 malformed widget records were withheld",
    );
    expect(visibleWidgetNames()).toEqual(["Homepage reviews"]);
  });

  it("distinguishes verified empty inventory and names the lifecycle dependency", async () => {
    mocks.listWidgets.mockResolvedValue({ data: { items: [] } });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "No widget records were returned",
    );
    expect(document.body.textContent).toContain(
      "complete, reversible lifecycle",
    );
    expect(document.body.textContent).not.toContain(
      "The widget inventory could not be verified",
    );
  });

  it("retains the last verified lifecycle snapshot across a failed refresh", async () => {
    const refresh = deferred<{
      error: { status: number; message: string };
    }>();
    mocks.listWidgets
      .mockResolvedValueOnce({
        data: {
          items: [wireWidget({ name: "Retained active widget" })],
        },
      })
      .mockReturnValueOnce(refresh.promise);
    render();
    await flush();

    act(() => buttonNamed("Refresh").click());
    await flush();
    expect(document.body.textContent).toContain("Retained active widget");
    expect(buttonNamed("Verifying…").disabled).toBe(true);

    refresh.resolve({
      error: {
        status: 500,
        message: "private datastore credentials and stack",
      },
    });
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Showing the last verified widget inventory");
    expect(text).toContain("Retained active widget");
    expect(text).toContain("The service could not complete the request.");
    expect(text).not.toContain("private datastore credentials");
    expect(text).not.toContain("The widget inventory could not be verified");
    expect(buttonNamed("Retry")).toBeTruthy();
  });

  it("does not infer renderer labels when the catalog is unavailable", async () => {
    mocks.listWidgets.mockResolvedValue({
      data: {
        items: [
          wireWidget({
            widget_type: "future_renderer",
            name: "Exact renderer record",
          }),
        ],
      },
    });
    render({
      widgetTypes: null,
      catalogUnavailable: true,
    });
    await flush();

    expect(document.body.textContent).toContain("Renderer catalog unavailable");
    expect(document.body.textContent).toContain("not being inferred");
    expect(document.body.textContent).not.toContain(
      "The server reports 2 renderer labels",
    );
    expect(visibleWidgetNames()).toEqual(["Exact renderer record"]);
  });
});
