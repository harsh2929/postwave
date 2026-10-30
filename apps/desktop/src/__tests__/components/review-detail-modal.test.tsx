// @vitest-environment happy-dom

import { act, createRef, type ReactElement } from "react";
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

import type { Review, ReviewPublicReply } from "../../lib/api/reviews";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  reply: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  reviewsApi: {
    get: mocks.get,
    approve: mocks.approve,
    reject: mocks.reject,
    reply: mocks.reply,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { ReviewDetailModal } from "../../components/reviews/ReviewDetailModal";

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
  mocks.get.mockReset();
  mocks.approve.mockReset();
  mocks.reject.mockReset();
  mocks.reply.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: "review-1",
    product_id: "product-1",
    variant_id: "variant-1",
    source_platform: "shopify",
    review_type: "product",
    reviewer_name: "A customer",
    rating: 5,
    title: "A complete title",
    body: "A complete review body.",
    status: "pending",
    verified_buyer: true,
    incentivized: false,
    featured: false,
    submitted_at: "2026-07-29T08:00:00.000Z",
    ...overrides,
  };
}

function reply(overrides: Partial<ReviewPublicReply> = {}): ReviewPublicReply {
  return {
    id: "reply-1",
    review_id: "review-1",
    author: "Store owner",
    body: "Thank you for the thoughtful feedback.",
    status: "published",
    created_at: "2026-07-29T09:00:00.000Z",
    ...overrides,
  };
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

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function modalNode(
  snapshot: Review,
  options: {
    canAdmin?: boolean;
    onClose?: () => void;
    onDecision?: (updated: Review) => void;
  } = {},
): ReactElement {
  const returnFocusRef = createRef<HTMLElement>();
  return (
    <ReviewDetailModal
      open
      review={snapshot}
      canAdmin={options.canAdmin ?? true}
      returnFocusRef={returnFocusRef}
      onClose={options.onClose ?? vi.fn()}
      onDecision={options.onDecision ?? vi.fn()}
    />
  );
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set?.bind(textarea);
  act(() => {
    setter?.(value);
    textarea.dispatchEvent(
      new Event("input", { bubbles: true, cancelable: true }),
    );
  });
}

describe("ReviewDetailModal", () => {
  it("labels the queue snapshot as partial, then renders complete safe evidence", async () => {
    const request = deferred<{ data: Review }>();
    mocks.get.mockReturnValue(request.promise);
    const snapshot = review({
      body: "Partial snapshot",
      reviewer_email: "private@example.test",
      order_id: "secret-order",
      customer_id: "secret-customer",
      raw_payload: { token: "secret-raw-token" },
    });

    render(modalNode(snapshot));

    expect(document.body.textContent).toContain(
      "partial moderation-queue snapshot",
    );
    expect(document.body.textContent).toContain("Partial snapshot");
    expect(button("Publish review").disabled).toBe(true);

    request.resolve({
      data: review({
        body: "The complete, untruncated customer submission.",
        moderation_reason: "Manual language check completed.",
        published_at: "2026-07-29T10:00:00.000Z",
        moderated_at: "2026-07-29T09:30:00.000Z",
        public_replies: [reply()],
        reviewer_email: "private@example.test",
        order_id: "secret-order",
        customer_id: "secret-customer",
        raw_payload: { token: "secret-raw-token" },
      }),
    });
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("The complete, untruncated customer submission.");
    expect(text).toContain("Manual language check completed.");
    expect(text).toContain("Thank you for the thoughtful feedback.");
    expect(text).toContain("Shopify");
    expect(text).toContain("Reported product");
    expect(text).toContain("Reported variant");
    expect(text).toContain("Sensitive fields hidden from this view");
    expect(text).toContain(
      "This screen does not independently verify their provenance or timestamps.",
    );
    expect(text).toContain("Reported author");
    expect(text).not.toContain("private@example.test");
    expect(text).not.toContain("secret-order");
    expect(text).not.toContain("secret-customer");
    expect(text).not.toContain("secret-raw-token");
    expect(button("Publish review").disabled).toBe(false);
  });

  it("retains a partial snapshot and safe copy when detail loading fails", async () => {
    mocks.get.mockResolvedValue({
      error: {
        message: "postgres password and reflected private input",
        status: 500,
      },
    });
    render(modalNode(review({ body: "Readable queue snapshot" })));
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Readable queue snapshot");
    expect(text).toContain("Complete evidence unavailable");
    expect(text).toContain("The service could not complete the request.");
    expect(text).not.toContain("postgres password");
    expect(button("Publish review").disabled).toBe(true);
    expect(button("Retry")).toBeTruthy();
  });

  it("retains the partial snapshot when the detail requester throws", async () => {
    mocks.get.mockImplementation(() => {
      throw new Error("raw transport secret must not render");
    });
    render(modalNode(review({ body: "Safe retained snapshot" })));
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Safe retained snapshot");
    expect(text).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(text).not.toContain("raw transport secret");
    expect(button("Publish review").disabled).toBe(true);
  });

  it("ignores a stale detail response after the selected review changes", async () => {
    const first = deferred<{ data: Review }>();
    const second = deferred<{ data: Review }>();
    mocks.get
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const rendered = render(
      modalNode(review({ id: "review-1", body: "First snapshot" })),
    );

    rendered.rerender(
      modalNode(review({ id: "review-2", body: "Second snapshot" })),
    );
    second.resolve({
      data: review({ id: "review-2", body: "Current complete evidence" }),
    });
    await flush();
    first.resolve({
      data: review({ id: "review-1", body: "Stale complete evidence" }),
    });
    await flush();

    expect(document.body.textContent).toContain("Current complete evidence");
    expect(document.body.textContent).not.toContain("Stale complete evidence");
  });

  it("keeps viewers read-only and explains their authority", async () => {
    mocks.get.mockResolvedValue({
      data: review({ status: "approved" }),
    });
    render(modalNode(review({ status: "approved" }), { canAdmin: false }));
    await flush();

    expect(document.body.textContent).toContain("Read-only review evidence");
    expect(
      Array.from(document.querySelectorAll("button")).some((candidate) =>
        /Publish review|Reject review|Write public reply/.test(
          candidate.textContent ?? "",
        ),
      ),
    ).toBe(false);
  });

  it("requires explicit publication confirmation and guards a same-tick double action", async () => {
    const pending = review();
    const published = review({
      status: "approved",
      published_at: "2026-07-29T10:00:00.000Z",
      moderated_at: "2026-07-29T10:00:00.000Z",
    });
    const mutation = deferred<{ data: Review }>();
    const onDecision = vi.fn();
    mocks.get.mockResolvedValue({ data: pending });
    mocks.approve.mockReturnValue(mutation.promise);
    render(modalNode(pending, { onDecision }));
    await flush();

    act(() => button("Publish review").click());
    expect(document.body.textContent).toContain(
      "The desktop app has no undo action.",
    );
    const confirm = button("Publish review now");
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(mocks.approve).toHaveBeenCalledTimes(1);
    mutation.resolve({ data: published });
    await flush();

    expect(onDecision).toHaveBeenCalledWith(published);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Review marked public by the service",
    );
    expect(document.body.textContent).toContain("Published");
    expect(document.body.textContent).not.toContain("Reject review");
  });

  it("requires an explicit irreversible rejection confirmation", async () => {
    const pending = review();
    const rejected = review({
      status: "rejected",
      moderated_at: "2026-07-29T10:00:00.000Z",
    });
    const onDecision = vi.fn();
    mocks.get.mockResolvedValue({ data: pending });
    mocks.reject.mockResolvedValue({ data: rejected });
    render(modalNode(pending, { onDecision }));
    await flush();

    act(() => button("Reject review").click());
    const confirmationText = document.body.textContent ?? "";
    expect(confirmationText).toContain("No desktop recovery path");
    expect(confirmationText).toContain("no restore action");
    expect(confirmationText).toContain(
      "no endpoint for recording a rejection reason",
    );
    act(() => button("Reject review now").click());
    await flush();

    expect(mocks.reject).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith(rejected);
    expect(document.body.textContent).toContain("No desktop restore path");
  });

  it("withholds raw mutation errors and keeps the confirmation recoverable", async () => {
    const pending = review();
    mocks.get.mockResolvedValue({ data: pending });
    mocks.approve.mockResolvedValue({
      error: {
        status: 403,
        message: "private SQL detail and reflected customer content",
      },
    });
    render(modalNode(pending));
    await flush();

    act(() => button("Publish review").click());
    act(() => button("Publish review now").click());
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Your current role does not have permission to read this data.",
    );
    expect(text).not.toContain("private SQL detail");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The review was not published. Your current role does not have permission to read this data.",
    );
    expect(button("Publish review now").disabled).toBe(false);
  });

  it.each([
    {
      method: "approve" as const,
      openLabel: "Publish review",
      confirmLabel: "Publish review now",
      failureLead: "The review was not published.",
    },
    {
      method: "reject" as const,
      openLabel: "Reject review",
      confirmLabel: "Reject review now",
      failureLead: "The review was not rejected.",
    },
  ])(
    "clears busy state when the $method requester throws",
    async ({ method, openLabel, confirmLabel, failureLead }) => {
      const pending = review();
      mocks.get.mockResolvedValue({ data: pending });
      mocks[method].mockRejectedValue(new Error("raw thrown mutation detail"));
      render(modalNode(pending));
      await flush();

      act(() => button(openLabel).click());
      act(() => button(confirmLabel).click());
      await flush();

      expect(mocks[method]).toHaveBeenCalledTimes(1);
      expect(button(confirmLabel).disabled).toBe(false);
      expect(document.body.textContent).not.toContain(
        "raw thrown mutation detail",
      );
      expect(mocks.toastError).toHaveBeenCalledWith(
        `${failureLead} The service could not be reached. Check the connection and retry.`,
      );
    },
  );

  it("previews the exact reply, publishes once, and appends only after success", async () => {
    const published = review({
      status: "approved",
      public_replies: [],
      published_at: "2026-07-29T10:00:00.000Z",
    });
    const mutation = deferred<{ data: ReviewPublicReply }>();
    const createdReply = reply({
      id: "reply-created",
      body: "Exact public response.",
    });
    mocks.get.mockResolvedValue({ data: published });
    mocks.reply.mockReturnValue(mutation.promise);
    render(modalNode(published));
    await flush();

    act(() => button("Write public reply").click());
    await flush();
    const textarea = document.querySelector("textarea");
    expect(textarea).toBeTruthy();
    expect(document.activeElement).toBe(textarea);
    changeTextarea(textarea!, "  Exact public response.  ");
    expect(document.body.textContent).toContain("26 / 4,000");
    act(() => button("Review public reply").click());

    expect(
      document.querySelector('[aria-label="Exact public reply preview"]')
        ?.textContent,
    ).toContain("Exact public response.");
    const confirm = button("Publish reply now");
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.reply).toHaveBeenCalledWith(
      "review-1",
      "Exact public response.",
    );
    expect(
      document.querySelector(
        ".reviews-detail__replies .reviews-detail__section-heading span",
      )?.textContent,
    ).toBe("0");

    mutation.resolve({ data: createdReply });
    await flush();

    expect(document.body.textContent).toContain("Exact public response.");
    expect(
      document.querySelector(
        ".reviews-detail__replies .reviews-detail__section-heading span",
      )?.textContent,
    ).toBe("1");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Reply marked public by the service",
    );
  });

  it("keeps the exact reply preview recoverable when the requester throws", async () => {
    const published = review({
      status: "approved",
      public_replies: [],
      published_at: "2026-07-29T10:00:00.000Z",
    });
    mocks.get.mockResolvedValue({ data: published });
    mocks.reply.mockRejectedValue(new Error("raw reply transport detail"));
    render(modalNode(published));
    await flush();

    act(() => button("Write public reply").click());
    await flush();
    const textarea = document.querySelector("textarea");
    changeTextarea(textarea!, "Please keep this exact public reply.");
    act(() => button("Review public reply").click());
    act(() => button("Publish reply now").click());
    await flush();

    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(button("Publish reply now").disabled).toBe(false);
    expect(document.body.textContent).toContain(
      "Please keep this exact public reply.",
    );
    expect(document.body.textContent).not.toContain(
      "raw reply transport detail",
    );
    expect(
      document.querySelector(
        ".reviews-detail__replies .reviews-detail__section-heading span",
      )?.textContent,
    ).toBe("0");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The public reply was not published. The service could not be reached. Check the connection and retry.",
    );
  });
});
