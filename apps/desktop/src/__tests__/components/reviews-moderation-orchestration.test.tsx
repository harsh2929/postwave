// @vitest-environment happy-dom

import { act, type ReactElement, type RefObject } from "react";
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

import type { Review } from "../../lib/api/reviews";

const mocks = vi.hoisted(() => ({
  detailProps: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  reviewsApi: {
    list: mocks.list,
  },
}));

vi.mock("../../components/Icon", () => ({
  Icon: ({ name }: { name: string }) => (
    <span aria-hidden="true" data-test-icon={name} />
  ),
}));

vi.mock("../../components/reviews/ReviewDetailModal", () => ({
  ReviewDetailModal: (props: {
    open: boolean;
    review: Review | null;
    canAdmin: boolean;
    returnFocusRef: RefObject<HTMLElement | null>;
    onClose: () => void;
    onDecision: (updated: Review) => void;
  }) => {
    mocks.detailProps(props);
    return props.open ? (
      <div data-testid="review-detail-boundary">
        detail:{props.review?.id}:{String(props.canAdmin)}
        <button type="button" onClick={props.onClose}>
          Close detail boundary
        </button>
      </div>
    ) : null;
  },
}));

import { ModerationTab } from "../../components/reviews/ModerationTab";

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
  mocks.list.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function wireReview(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "review-1",
    product_id: "product-1",
    source_platform: "postwave",
    review_type: "product",
    reviewer_name: "Customer",
    reviewer_email: "private@example.test",
    rating: 5,
    title: "A useful review",
    body: "Durable and bright.",
    status: "pending",
    verified_buyer: true,
    incentivized: false,
    featured: false,
    submitted_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function render(
  props: Partial<Parameters<typeof ModerationTab>[0]> = {},
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const node: ReactElement = (
    <ModerationTab
      statuses={["pending", "approved", "rejected", "future_state"]}
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

function buttonContaining(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => normalizedText(candidate).includes(label));
  if (!match) throw new Error(`Missing button containing: ${label}`);
  return match;
}

function filterButton(label: string): HTMLButtonElement {
  const group = document.querySelector(
    '[role="group"][aria-label="Filter reviews by moderation state"]',
  );
  const match = Array.from(
    group?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((candidate) => normalizedText(candidate) === label);
  if (!match) throw new Error(`Missing moderation filter: ${label}`);
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

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set?.bind(select);
  act(() => {
    setter?.(value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function cardHeadings(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".reviews-card h3"),
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

describe("Reviews moderation orchestration", () => {
  it("treats a malformed list envelope as terminal integrity failure, never empty success", async () => {
    mocks.list.mockResolvedValue({ data: { items: "not-an-array" } });
    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("The review queue could not be verified");
    expect(text).toContain("The server could not verify this data.");
    expect(text).not.toContain("No pending reviews in this loaded window");
    expect(
      document
        .querySelector('[aria-label="Review queue"]')
        ?.getAttribute("aria-busy"),
    ).toBe("false");
  });

  it("withholds malformed rows, reports their count, and retains verified rows", async () => {
    mocks.list.mockResolvedValue({
      data: {
        items: [
          wireReview(),
          wireReview({ id: "" }),
          wireReview({ id: "bad-rating", rating: 7 }),
        ],
      },
    });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "2 malformed records were withheld",
    );
    expect(cardHeadings()).toEqual(["A useful review"]);
    expect(document.querySelectorAll(".reviews-card")).toHaveLength(1);
  });

  it("redacts terminal transport failures and distinguishes a verified empty queue", async () => {
    mocks.list.mockResolvedValueOnce({
      error: {
        status: 500,
        message: "database password and reflected reviewer email",
      },
    });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "The review queue could not be verified",
    );
    expect(document.body.textContent).toContain(
      "The service could not complete the request.",
    );
    expect(document.body.textContent).not.toContain("database password");

    act(() => root?.unmount());
    root = createRoot(container!);
    mocks.list.mockResolvedValueOnce({ data: { items: [] } });
    act(() => root?.render(<ModerationTab statuses={["pending"]} canAdmin />));
    await flush();

    expect(document.body.textContent).toContain(
      "No pending reviews in this loaded window",
    );
    expect(document.body.textContent).not.toContain(
      "The review queue could not be verified",
    );
  });

  it("retains the last verified queue when a refresh fails and never exposes raw diagnostics", async () => {
    const refresh = deferred<{
      error: { status: number; message: string };
    }>();
    mocks.list
      .mockResolvedValueOnce({
        data: { items: [wireReview({ title: "Retained evidence" })] },
      })
      .mockReturnValueOnce(refresh.promise);
    render();
    await flush();

    act(() => buttonNamed("Refresh").click());
    await flush();
    expect(document.body.textContent).toContain("Retained evidence");
    expect(buttonNamed("Verifying…").disabled).toBe(true);

    refresh.resolve({
      error: {
        status: 500,
        message: "private SQL trace and customer payload",
      },
    });
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Showing the last verified queue");
    expect(text).toContain("Retained evidence");
    expect(text).toContain("The service could not complete the request.");
    expect(text).not.toContain("private SQL trace");
    expect(text).not.toContain("The review queue could not be verified");
    expect(buttonNamed("Retry")).toBeTruthy();
  });

  it("discloses the exact 200-row server window without claiming completeness", async () => {
    mocks.list.mockResolvedValue({
      data: {
        items: Array.from({ length: 200 }, (_, index) =>
          wireReview({
            id: `review-${index}`,
            title: `Review ${index}`,
            submitted_at: new Date(
              Date.UTC(2026, 6, 1, 0, index),
            ).toISOString(),
          }),
        ),
      },
    });
    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("This server returned its 200-record maximum");
    expect(text).toContain("loaded window, not proof");
    expect(document.querySelectorAll(".reviews-card")).toHaveLength(200);
  });

  it("searches the verified window and changes ordering without mutating source truth", async () => {
    mocks.list.mockResolvedValue({
      data: {
        items: [
          wireReview({
            id: "newest",
            title: "Newest banana",
            body: "Banana yellow",
            submitted_at: "2026-07-03T00:00:00Z",
          }),
          wireReview({
            id: "oldest",
            title: "Oldest lamp",
            body: "Durable lamp",
            submitted_at: "2026-07-01T00:00:00Z",
          }),
        ],
      },
    });
    render();
    await flush();

    expect(cardHeadings()).toEqual(["Oldest lamp", "Newest banana"]);
    const order = document.querySelector<HTMLSelectElement>(
      ".reviews-sort select",
    );
    if (!order) throw new Error("Missing review order control");
    setSelect(order, "newest");
    expect(cardHeadings()).toEqual(["Newest banana", "Oldest lamp"]);

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    if (!search) throw new Error("Missing review search");
    setInput(search, "durable");
    expect(cardHeadings()).toEqual(["Oldest lamp"]);
    setInput(search, "no-match");
    expect(document.body.textContent).toContain(
      "No loaded reviews match this search",
    );
    act(() => buttonNamed("Clear search").click());
    expect(cardHeadings()).toEqual(["Newest banana", "Oldest lamp"]);
  });

  it("ignores a superseded status response and keeps the newest filter truth", async () => {
    const pending = deferred<{ data: { items: Record<string, unknown>[] } }>();
    const approved = deferred<{ data: { items: Record<string, unknown>[] } }>();
    mocks.list
      .mockReturnValueOnce(pending.promise)
      .mockReturnValueOnce(approved.promise);
    render();
    await flush();

    expect(mocks.list).toHaveBeenNthCalledWith(1, { status: "pending" });
    act(() => filterButton("Published").click());
    await flush();
    expect(mocks.list).toHaveBeenNthCalledWith(2, { status: "approved" });

    approved.resolve({
      data: {
        items: [
          wireReview({
            id: "published-review",
            title: "Current published result",
            status: "approved",
          }),
        ],
      },
    });
    await flush();
    expect(document.body.textContent).toContain("Current published result");
    expect(filterButton("Published").getAttribute("aria-pressed")).toBe("true");

    pending.resolve({
      data: {
        items: [
          wireReview({
            id: "stale-pending",
            title: "Superseded pending result",
          }),
        ],
      },
    });
    await flush();

    expect(document.body.textContent).toContain("Current published result");
    expect(document.body.textContent).not.toContain(
      "Superseded pending result",
    );
  });

  it("opens the full-detail boundary from the exact row and delegates viewer authority", async () => {
    mocks.list.mockResolvedValue({
      data: { items: [wireReview({ id: "review-boundary" })] },
    });
    render({ canAdmin: false });
    await flush();

    expect(document.body.textContent).toContain("Read-only review access");
    const opener = buttonContaining("Inspect evidence");
    act(() => {
      opener.focus();
      opener.click();
    });

    const props = mocks.detailProps.mock.lastCall?.[0] as
      | {
          open: boolean;
          review: Review | null;
          canAdmin: boolean;
          returnFocusRef: RefObject<HTMLElement | null>;
        }
      | undefined;
    expect(props).toMatchObject({
      open: true,
      review: expect.objectContaining({ id: "review-boundary" }),
      canAdmin: false,
    });
    expect(props?.returnFocusRef.current).toBe(opener);
    expect(
      document.querySelector('[data-testid="review-detail-boundary"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain("private@example.test");

    act(() => buttonNamed("Close detail boundary").click());
    expect(
      (mocks.detailProps.mock.lastCall?.[0] as { open: boolean }).open,
    ).toBe(false);
  });
});
