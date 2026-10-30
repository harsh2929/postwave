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
  catalogue: vi.fn(),
  copy: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { getMCPCatalog: mocks.catalogue },
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.copy,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { McpToolCatalog } from "../../components/mcp/McpToolCatalog";
import { navigateDesktopRoute } from "../../lib/desktop-router";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const catalogue = [
  {
    name: "subscribers_list",
    category: "Subscribers",
    description: "List subscriber profiles.",
  },
  {
    name: "campaigns_send",
    category: "Campaigns",
    description: "Submit an approved campaign send.",
  },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.catalogue.mockResolvedValue({ data: catalogue });
  mocks.copy.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "public",
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: null,
  });
  navigateDesktopRoute({ section: "mcp", tab: "tools" }, { replace: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <McpToolCatalog identityScope="user-1:tenant-1:admin:epoch-1" />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error("Missing button: " + label);
  return match;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("McpToolCatalog maturity", () => {
  it("restores shareable search and category state from the desktop route", async () => {
    navigateDesktopRoute(
      {
        section: "mcp",
        tab: "tools",
        query: "campaign",
        filters: [{ key: "catalog-category", value: "Campaigns" }],
      },
      { replace: true },
    );
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("campaigns_send");
    });

    expect(document.querySelector<HTMLInputElement>(".mcp-search")?.value).toBe(
      "campaign",
    );
    expect(button("Campaigns 1").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).not.toContain("subscribers_list");
  });

  it("caps hostile search pastes before route state or catalogue scans", async () => {
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("subscribers_list");
    });
    const search = document.querySelector<HTMLInputElement>(".mcp-search")!;
    expect(search.maxLength).toBe(256);

    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(search, "x".repeat(10_000));
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>(".mcp-search")?.value,
      ).toHaveLength(256);
    });
    expect(document.body.textContent).toContain("0 of 2 tools match");
  });

  it("renders labeled exact identifiers, searchable counts, and an axe-clean surface", async () => {
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("subscribers_list");
    });

    expect(document.querySelector("label[for]")?.textContent).toBe(
      "Search tools",
    );
    expect(document.body.textContent).toContain("2 tools across 2 categories");
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(document.querySelectorAll(":disabled")).toHaveLength(0);
    expect(
      button("Refresh catalogue").getAttribute("aria-describedby"),
    ).toBeTruthy();
    expect(
      document
        .querySelector('button[aria-label*="subscribers_list"]')
        ?.getAttribute("aria-describedby"),
    ).toBeTruthy();

    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("single-flights refresh and retains verified data behind a safe stale notice", async () => {
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("subscribers_list");
    });
    const pending = deferred<{
      error: { kind: "network"; message: string };
    }>();
    mocks.catalogue.mockReturnValueOnce(pending.promise);
    const refresh = button("Refresh catalogue");
    act(() => {
      refresh.click();
      refresh.click();
    });
    expect(mocks.catalogue).toHaveBeenCalledTimes(2);
    expect(refresh.disabled).toBe(false);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");

    pending.resolve({
      error: {
        kind: "network",
        message: "raw database host and pw_internal_secret",
      },
    });
    await act(async () => {
      await pending.promise;
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Showing the last response-validated candidate catalogue",
      );
    });
    expect(document.body.textContent).toContain("subscribers_list");
    expect(document.body.textContent).not.toContain("pw_internal_secret");
  });

  it("clears a previously verified catalogue when refreshed access is denied", async () => {
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("subscribers_list");
    });
    mocks.catalogue.mockResolvedValueOnce({
      error: {
        status: 403,
        code: "forbidden",
        message: "raw role detail",
      },
    });

    act(() => button("Refresh catalogue").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Catalogue access denied");
    });
    expect(document.body.textContent).not.toContain("subscribers_list");
    expect(document.body.textContent).not.toContain("raw role detail");
  });

  it("single-flights per-tool clipboard writes", async () => {
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("subscribers_list");
    });
    const pending = deferred<{
      ok: true;
      backend: "web";
      contentClass: "public";
      clearScheduled: false;
      clearAfterMs: null;
      historyWarning: null;
    }>();
    mocks.copy.mockReturnValueOnce(pending.promise);
    const copy = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) =>
      candidate.getAttribute("aria-label")?.includes("campaigns_send"),
    )!;
    act(() => {
      copy.click();
      copy.click();
    });
    expect(mocks.copy).toHaveBeenCalledTimes(1);

    pending.resolve({
      ok: true,
      backend: "web",
      contentClass: "public",
      clearScheduled: false,
      clearAfterMs: null,
      historyWarning: null,
    });
    await act(async () => {
      await pending.promise;
      await Promise.resolve();
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Tool identifier copied");
  });

  it("contains a rejected clipboard backend behind safe recovery copy", async () => {
    mocks.copy.mockRejectedValueOnce(
      new Error("raw clipboard adapter pw_live_internal_secret"),
    );
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("subscribers_list");
    });
    const copy = document.querySelector<HTMLButtonElement>(
      'button[aria-label*="subscribers_list"]',
    )!;

    act(() => copy.click());
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The tool identifier could not be copied. Focus Moosewave and retry.",
    );
    expect(document.body.textContent).not.toContain("pw_live_internal_secret");
  });

  it("fails closed on catalogue text that can spoof visual order", async () => {
    mocks.catalogue.mockResolvedValueOnce({
      data: [
        {
          name: "subscribers_list",
          category: "Subscribers",
          description: "Trusted label\u202espell-out",
        },
      ],
    });
    render();

    await waitFor(() => {
      expect(document.body.textContent).toContain("Catalogue unavailable");
    });
    expect(document.body.textContent).not.toContain("spell-out");
  });
});
