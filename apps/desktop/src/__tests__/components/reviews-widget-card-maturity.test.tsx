// @vitest-environment happy-dom

import { act, StrictMode, type ReactElement } from "react";
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
  clipboard: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  widgetEmbed: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  reviewsApi: {
    widgetEmbed: mocks.widgetEmbed,
  },
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.clipboard,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { WidgetCard } from "../../components/reviews/WidgetCard";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clipboard.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "public",
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: null,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

function widget(
  overrides: Record<string, unknown> = {},
): Parameters<typeof WidgetCard>[0]["widget"] {
  return {
    id: "widget-1",
    slug: "homepage-reviews",
    name: "Homepage reviews",
    status: "active",
    widget_type: "product_reviews",
    language: "en",
    public_url:
      "https://reviews.example.test/api/public/reviews/widgets/homepage-reviews",
    updated_at: "2026-07-29T08:30:00.000Z",
    ...overrides,
  };
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root?.render(element);
  });
}

function visibleText(): string {
  return container?.textContent ?? "";
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(
    container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find(
    (candidate) =>
      candidate.textContent?.replace(/\s+/gu, " ").trim().includes(name) ===
      true,
  );
  if (!found) throw new Error(`Missing button containing "${name}"`);
  return found;
}

async function click(control: HTMLElement): Promise<void> {
  await act(async () => {
    control.focus();
    control.click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("WidgetCard deployment authority", () => {
  for (const status of ["draft", "paused", "archived", "unexpected"]) {
    it(`keeps ${status} widget deployment material out of the DOM`, async () => {
      await render(<WidgetCard widget={widget({ status })} />);

      expect(visibleText()).not.toContain(
        "https://reviews.example.test/api/public/reviews/widgets/homepage-reviews",
      );
      expect(visibleText()).not.toContain("Inspect reported endpoint");
      expect(visibleText()).not.toContain("Copy endpoint URL");
      expect(visibleText()).not.toContain("Review installation");
      expect(mocks.widgetEmbed).not.toHaveBeenCalled();
    });
  }

  it("fails closed when an active widget has an unsafe public URL", async () => {
    await render(
      <WidgetCard
        widget={widget({ public_url: "javascript:window.location='bad'" })}
      />,
    );

    expect(visibleText()).toContain("Reported endpoint unavailable");
    expect(visibleText()).not.toContain("javascript:");
    expect(visibleText()).not.toContain("Inspect reported endpoint");
    expect(visibleText()).not.toContain("Copy endpoint URL");
    expect(visibleText()).not.toContain("Review installation");
    expect(mocks.widgetEmbed).not.toHaveBeenCalled();
  });

  it("shows a safe active endpoint but withholds installation without an id", async () => {
    await render(<WidgetCard widget={widget({ id: undefined })} />);

    expect(visibleText()).toContain("Reported public endpoint");
    expect(visibleText()).toContain("Endpoint access withheld");
    expect(visibleText()).toContain(
      "Tenant ownership and rendered output are not verified",
    );
    expect(visibleText()).not.toContain("Inspect reported endpoint");
    expect(visibleText()).not.toContain("Copy endpoint URL");
    expect(visibleText()).toContain("Do not share or install this address");
    expect(visibleText()).toContain(
      "Installation code is unavailable because this widget has no stable identifier.",
    );
    expect(visibleText()).not.toContain("Review installation");
  });
});

describe("WidgetCard installation review", () => {
  it("fetches only the selected flavor, caches each result, and restores exact opener focus", async () => {
    mocks.widgetEmbed.mockImplementation(
      async (_id: string, flavor: "iframe" | "script") =>
        flavor === "iframe"
          ? {
              data: {
                flavor,
                snippet:
                  '<iframe src="https://reviews.example.test/api/public/reviews/widgets/homepage-reviews/html" title="Customer reviews"></iframe>',
              },
            }
          : {
              data: {
                flavor,
                snippet:
                  '<script async src="https://reviews.example.test/embed.js"></script>',
              },
            },
    );

    await render(
      <StrictMode>
        <WidgetCard widget={widget()} />
      </StrictMode>,
    );
    const opener = button("Review installation");
    await click(opener);

    expect(mocks.widgetEmbed).toHaveBeenCalledTimes(1);
    expect(mocks.widgetEmbed).toHaveBeenLastCalledWith("widget-1", "iframe");
    expect(document.activeElement).toBe(button("Iframe"));
    expect(visibleText()).toContain("Customer reviews");
    expect(button("Copy iframe code").disabled).toBe(false);
    await click(button("Copy iframe code"));
    expect(mocks.clipboard).toHaveBeenCalledWith(
      '<iframe src="https://reviews.example.test/api/public/reviews/widgets/homepage-reviews/html" title="Customer reviews"></iframe>',
      {
        contentClass: "public",
        label: "Iframe installation code",
      },
    );

    await click(button("Script"));
    expect(mocks.widgetEmbed).toHaveBeenCalledTimes(2);
    expect(mocks.widgetEmbed).toHaveBeenLastCalledWith("widget-1", "script");
    expect(visibleText()).toContain("Storefront delivery not certified");
    expect(button("Script copy unavailable").disabled).toBe(true);

    await click(button("Iframe"));
    expect(mocks.widgetEmbed).toHaveBeenCalledTimes(2);

    await click(button("Script"));
    expect(mocks.clipboard).toHaveBeenCalledTimes(1);

    await click(button("Close"));
    await act(async () => Promise.resolve());
    expect(document.activeElement).toBe(opener);
  });

  it("renders missing iframe title and rendered-view target as visible copy blockers", async () => {
    mocks.widgetEmbed.mockResolvedValue({
      data: {
        flavor: "iframe",
        snippet:
          '<iframe data-src="https://reviews.example.test/api/public/reviews/widgets/homepage-reviews/html" data-title="Customer reviews"></iframe>',
      },
    });

    await render(<WidgetCard widget={widget()} />);
    await click(button("Review installation"));

    expect(visibleText()).toContain("Iframe copy blocked");
    expect(visibleText()).toContain("needs a non-empty title");
    expect(visibleText()).toContain("rendered /html view");
    expect(button("Iframe copy unavailable").disabled).toBe(true);
    expect(mocks.clipboard).not.toHaveBeenCalled();
  });

  it("blocks a titled iframe that still points at a non-rendered endpoint", async () => {
    mocks.widgetEmbed.mockResolvedValue({
      data: {
        flavor: "iframe",
        snippet:
          '<iframe src="https://reviews.example.test/api/public/reviews/widgets/homepage-reviews" title="Customer reviews"></iframe>',
      },
    });

    await render(<WidgetCard widget={widget()} />);
    await click(button("Review installation"));

    expect(visibleText()).toContain("Iframe copy blocked");
    expect(visibleText()).toContain("does not target the rendered /html view");
    expect(button("Iframe copy unavailable").disabled).toBe(true);
    expect(mocks.clipboard).not.toHaveBeenCalled();
  });

  it("redacts remote errors and retries only the failed flavor", async () => {
    mocks.widgetEmbed
      .mockResolvedValueOnce({
        error: {
          status: 500,
          message: "database secret and internal stack",
        },
      })
      .mockResolvedValueOnce({
        data: {
          flavor: "iframe",
          snippet:
            '<iframe src="https://reviews.example.test/public" title="Customer reviews"></iframe>',
        },
      });

    await render(<WidgetCard widget={widget()} />);
    await click(button("Review installation"));

    expect(visibleText()).toContain(
      "The service could not complete the request.",
    );
    expect(visibleText()).not.toContain("database secret");
    await click(button("Retry iframe"));

    expect(mocks.widgetEmbed).toHaveBeenCalledTimes(2);
    expect(mocks.widgetEmbed).toHaveBeenNthCalledWith(1, "widget-1", "iframe");
    expect(mocks.widgetEmbed).toHaveBeenNthCalledWith(2, "widget-1", "iframe");
    expect(visibleText()).toContain("Customer reviews");
  });

  it("contains a thrown embed request and permits an explicit retry", async () => {
    mocks.widgetEmbed
      .mockRejectedValueOnce(new Error("private transport diagnostics"))
      .mockResolvedValueOnce({
        data: {
          flavor: "iframe",
          snippet:
            '<iframe src="https://reviews.example.test/public" title="Customer reviews"></iframe>',
        },
      });

    await render(<WidgetCard widget={widget()} />);
    await click(button("Review installation"));

    expect(visibleText()).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(visibleText()).not.toContain("private transport diagnostics");

    await click(button("Retry iframe"));
    expect(mocks.widgetEmbed).toHaveBeenCalledTimes(2);
    expect(visibleText()).toContain("Customer reviews");
  });

  it("rejects oversized snippets without exposing or copying them", async () => {
    mocks.widgetEmbed.mockResolvedValue({
      data: {
        flavor: "iframe",
        snippet: `<iframe title="Customer reviews">${"x".repeat(32_769)}</iframe>`,
      },
    });

    await render(<WidgetCard widget={widget()} />);
    await click(button("Review installation"));

    expect(visibleText()).toContain("32 KiB safety limit");
    expect(visibleText()).not.toContain("x".repeat(128));
    expect(mocks.clipboard).not.toHaveBeenCalled();
  });
});
