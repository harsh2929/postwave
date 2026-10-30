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
  renderPreview: vi.fn(),
  recommendations: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { renderEmailPreview: mocks.renderPreview },
  apiSendTimeAssets: {
    getProductRecommendations: mocks.recommendations,
  },
}));

import {
  EmailPreviewTabs,
  isolatedPreviewDocument,
  safeProductImageUrl,
} from "../../components/EmailPreviewTabs";

const renderedHtml =
  '<div><img src="https://tracker.example/pixel.gif"><script>alert(1)</script><p>Hello</p></div>';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.renderPreview.mockReset();
  mocks.recommendations.mockReset();
  mocks.renderPreview.mockResolvedValue({
    data: {
      renderer: "mjml",
      previews: {
        gmail: renderedHtml,
        outlook: "<p>Outlook</p>",
        apple: "<p>Apple</p>",
        dark: "<p>Dark</p>",
      },
      warnings: [],
    },
  });
  mocks.recommendations.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function render(body = "<p>Hello</p>"): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(<EmailPreviewTabs body={body} vars={{ name: "Ada" }} />),
  );
}

async function advancePreviewDebounce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
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

describe("EmailPreviewTabs maturity", () => {
  it("isolates preview markup with a deny-by-default CSP and unique-origin sandbox", async () => {
    render();
    await advancePreviewDebounce();

    const frame = document.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("title")).toBe("Gmail preview");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const source = frame?.getAttribute("srcdoc") ?? "";
    expect(source).toContain('http-equiv="Content-Security-Policy"');
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("img-src data: blob:");
    expect(source).toContain("connect-src 'none'");
    expect(source).toContain("form-action 'none'");
    expect(container?.querySelector("[title]:not(iframe)")).toBeNull();

    // happy-dom does not expose an iframe Window that axe can message. The
    // frame's accessible title and sandbox are asserted directly above; axe
    // audits the surrounding interactive surface after removing that test-only
    // transport limitation.
    frame?.remove();
    vi.useRealTimers();
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("single-flights manual refresh and keeps its busy action focusable", async () => {
    render();
    await advancePreviewDebounce();
    let resolveRefresh!: (value: unknown) => void;
    mocks.renderPreview.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const refresh = button("Refresh preview");
    await act(async () => {
      refresh.click();
      refresh.click();
      await Promise.resolve();
    });
    expect(mocks.renderPreview).toHaveBeenCalledTimes(2);
    const busy = button("Refreshing…");
    expect(busy.disabled).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      resolveRefresh({
        data: {
          renderer: "mjml",
          previews: {
            gmail: "<p>Refreshed</p>",
            outlook: "",
            apple: "",
            dark: "",
          },
          warnings: [],
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button("Refresh preview")).toBeTruthy();
  });

  it("gives recommendations their own refresh and exposes full ranking context", async () => {
    mocks.recommendations.mockResolvedValueOnce({
      data: {
        items: [
          {
            product_id: "product-1",
            title: "A complete product title that must remain visible",
            image_url: "http://insecure.example/product.jpg",
            price_cents: 1299,
            currency: "usd",
            score: 0.92,
            reason: "Purchased together with the subscriber's recent order",
          },
        ],
      },
    });
    render("");
    act(() => button("Recommendations").click());
    await flush();

    expect(document.body.textContent).toContain(
      "A complete product title that must remain visible",
    );
    expect(document.body.textContent).toContain(
      "Purchased together with the subscriber's recent order",
    );
    expect(document.body.textContent).toContain("Recommendation score 0.92");
    expect(button("Refresh recommendations")).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Refresh preview",
      ),
    ).toBe(false);
    expect(document.querySelector("img")).toBeNull();
    expect(container?.querySelector("[title]")).toBeNull();
  });

  it("contains recommendation throws and single-flights retry", async () => {
    mocks.recommendations
      .mockImplementationOnce(() => {
        throw new Error("private commerce database detail");
      })
      .mockResolvedValueOnce({ data: { items: [] } });
    render("");
    act(() => button("Recommendations").click());
    await flush();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain(
      "private commerce database detail",
    );
    const retry = button("Retry recommendations");
    await act(async () => {
      retry.click();
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.recommendations).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("No products to recommend");
  });

  it("injects CSP into fragments and complete documents and rejects unsafe image URLs", () => {
    expect(isolatedPreviewDocument("<p>Fragment</p>")).toMatch(
      /<head><meta http-equiv="Content-Security-Policy"/,
    );
    expect(
      isolatedPreviewDocument("<html><body>Complete</body></html>"),
    ).toContain("<html><head><meta");
    expect(
      isolatedPreviewDocument("<html><head><style></style></head></html>"),
    ).toContain("<head><meta");
    expect(safeProductImageUrl("https://cdn.example/product.jpg")).toBe(
      "https://cdn.example/product.jpg",
    );
    expect(
      safeProductImageUrl("http://cdn.example/product.jpg"),
    ).toBeUndefined();
    expect(safeProductImageUrl("file:///private/customer.db")).toBeUndefined();
    expect(safeProductImageUrl("javascript:alert(1)")).toBeUndefined();
  });
});
