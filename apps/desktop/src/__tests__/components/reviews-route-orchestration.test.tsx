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
  canAdmin: true,
  catalog: vi.fn(),
  initialTab: "moderation",
  moderationProps: vi.fn(),
  navigateDesktopRoute: vi.fn(),
  routeHook: vi.fn(),
  widgetsProps: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  reviewsApi: {
    catalog: mocks.catalog,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../lib/desktop-router", async () => {
  const React = await import("react");
  return {
    navigateDesktopRoute: mocks.navigateDesktopRoute,
    useDesktopRouteTab: <Value extends string>(
      section: string,
      allowed: readonly Value[],
      fallback: Value,
    ) => {
      mocks.routeHook(section, allowed, fallback);
      return React.useState<Value>(mocks.initialTab as Value);
    },
  };
});

vi.mock("../../components/Icon", () => ({
  Icon: ({ name }: { name: string }) => (
    <span aria-hidden="true" data-test-icon={name} />
  ),
}));

vi.mock("../../components/reviews/ModerationTab", () => ({
  ModerationTab: (props: {
    statuses: string[] | null;
    catalogUnavailable?: boolean;
    canAdmin: boolean;
  }) => {
    mocks.moderationProps(props);
    return (
      <div data-testid="moderation-boundary">
        moderation:{String(props.canAdmin)}:{(props.statuses ?? []).join(",")}
      </div>
    );
  },
}));

vi.mock("../../components/reviews/WidgetsTab", () => ({
  WidgetsTab: (props: {
    widgetTypes: string[] | null;
    catalogUnavailable?: boolean;
    canAdmin: boolean;
  }) => {
    mocks.widgetsProps(props);
    return (
      <div data-testid="widgets-boundary">
        widgets:{String(props.canAdmin)}:{(props.widgetTypes ?? []).join(",")}
      </div>
    );
  },
}));

import { Reviews } from "../../pages/Reviews";

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
  mocks.canAdmin = true;
  mocks.initialTab = "moderation";
  mocks.catalog.mockResolvedValue({
    data: {
      statuses: ["pending", "approved", "rejected"],
      widget_types: ["summary", "product_reviews"],
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

function render(node: ReactElement = <Reviews />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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

function tabNamed(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find(
    (candidate) => candidate.querySelector("strong")?.textContent === label,
  );
  if (!match) throw new Error(`Missing tab: ${label}`);
  return match;
}

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("Reviews route orchestration", () => {
  it("loads strict catalog truth, delegates authority, and names privacy/publication boundaries", async () => {
    render();
    await flush();

    expect(mocks.catalog).toHaveBeenCalledTimes(1);
    expect(mocks.routeHook).toHaveBeenCalledWith(
      "reviews",
      ["moderation", "widgets"],
      "moderation",
    );
    expect(mocks.moderationProps).toHaveBeenLastCalledWith({
      statuses: ["pending", "approved", "rejected"],
      catalogUnavailable: false,
      canAdmin: true,
    });
    expect(
      document.querySelector('[data-testid="widgets-boundary"]'),
    ).toBeNull();

    const text = document.body.textContent ?? "";
    expect(text).toContain("approval publishes");
    expect(text).toContain("public replies publish");
    expect(text).toContain("maximum loaded reviews");
    expect(text).toContain("Active only");
    expect(text).toContain("Reviewer contact details are never rendered");
    expect(text).toContain("Administrator decision authority");
  });

  it("uses manual APG tabs with exact routed panel ownership", async () => {
    render();
    await flush();

    const moderation = tabNamed("Moderation inbox");
    const widgets = tabNamed("Storefront widgets");
    const moderationPanel = document.getElementById(
      moderation.getAttribute("aria-controls") ?? "",
    );
    const widgetsPanel = document.getElementById(
      widgets.getAttribute("aria-controls") ?? "",
    );

    expect(
      document.querySelector(
        '[role="tablist"][aria-label="Reviews workspaces"]',
      ),
    ).not.toBeNull();
    expect(moderation.getAttribute("aria-selected")).toBe("true");
    expect(moderation.tabIndex).toBe(0);
    expect(widgets.tabIndex).toBe(-1);
    expect(moderationPanel?.getAttribute("aria-labelledby")).toBe(
      moderation.id,
    );
    expect(moderationPanel?.hasAttribute("hidden")).toBe(false);
    expect(widgetsPanel?.hasAttribute("hidden")).toBe(true);

    act(() => moderation.focus());
    expect(press(moderation, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(widgets);
    expect(moderation.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector('[data-testid="widgets-boundary"]'),
    ).toBeNull();

    expect(press(widgets, "Enter").defaultPrevented).toBe(true);
    expect(widgets.getAttribute("aria-selected")).toBe("true");
    expect(widgetsPanel?.hasAttribute("hidden")).toBe(false);
    expect(
      document.querySelector('[data-testid="widgets-boundary"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Storefront widgets selected. Inspect reported deployment material separately from inactive inventory.",
    );

    press(widgets, "Home");
    expect(document.activeElement).toBe(moderation);
    expect(widgets.getAttribute("aria-selected")).toBe("true");
    expect(press(moderation, " ").defaultPrevented).toBe(true);
    expect(moderation.getAttribute("aria-selected")).toBe("true");
  });

  it("fails malformed catalog envelopes closed while preserving the scoped moderation entry point", async () => {
    mocks.catalog.mockResolvedValue({
      data: { statuses: [], widget_types: "not-an-array" },
    });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "The review catalog could not be verified",
    );
    expect(document.body.textContent).toContain(
      "moderation inbox remains explicitly scoped to Pending",
    );
    expect(mocks.moderationProps).toHaveBeenLastCalledWith({
      statuses: null,
      catalogUnavailable: true,
      canAdmin: true,
    });
  });

  it("redacts a catalog failure, retries explicitly, and restores server labels", async () => {
    mocks.catalog
      .mockResolvedValueOnce({
        error: {
          status: 500,
          message: "database password and private request payload",
        },
      })
      .mockResolvedValueOnce({
        data: {
          statuses: ["pending", "approved"],
          widget_types: ["summary"],
        },
      });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "The review catalog could not be verified",
    );
    expect(document.body.textContent).toContain(
      "The service could not complete the request.",
    );
    expect(document.body.textContent).not.toContain("database password");

    act(() => buttonNamed("Retry catalog").click());
    await flush();

    expect(mocks.catalog).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(
      "The review catalog could not be verified",
    );
    expect(mocks.moderationProps).toHaveBeenLastCalledWith({
      statuses: ["pending", "approved"],
      catalogUnavailable: false,
      canAdmin: true,
    });
  });

  it("reports withheld catalog values without suppressing unknown valid enums", async () => {
    mocks.catalog.mockResolvedValue({
      data: {
        statuses: ["pending", "future_state", "", "pending"],
        widget_types: ["summary", "future_renderer"],
      },
    });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "Some catalog labels were withheld",
    );
    expect(document.body.textContent).toContain(
      "2 malformed or duplicate catalog entries were excluded",
    );
    expect(mocks.moderationProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statuses: ["pending", "future_state"],
      }),
    );
  });

  it("tells viewers the truth about authority and routes source management to Integrations", async () => {
    mocks.canAdmin = false;
    render();
    await flush();

    expect(document.body.textContent).toContain("Read-only evidence access");
    expect(mocks.moderationProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ canAdmin: false }),
    );

    act(() => buttonNamed("Manage review sources").click());
    expect(mocks.navigateDesktopRoute).toHaveBeenCalledWith({
      section: "integrations",
    });
  });
});
