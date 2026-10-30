// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The leads endpoint answers with up to 5,000 conversions in a single
// response, and this page rendered one <tr> per lead with no window: ~60,000
// DOM nodes against the project's own 3,000-node budget, plus a full re-render
// of every surviving row on each search keystroke. The full data set is still
// reachable through the CSV export, so the table shows a page at a time.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE_ID = "11111111-2222-3333-4444-555555555555";
const LEAD_COUNT = 500;
const LONG_METADATA = `source-${"x".repeat(2_000)}`;

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => `/app/landing-pages/${PAGE_ID}/submissions`,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: PAGE_ID }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => createElement("a", { href, ...props }, children),
}));

function leadsPayload(count: number) {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      email: `lead${i}@example.com`,
      at: "2026-07-10T00:00:00Z",
      metadata: { source: i === 0 ? LONG_METADATA : "hero" },
    })),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/leads")) {
        return Response.json(leadsPayload(LEAD_COUNT));
      }
      return Response.json({ id: PAGE_ID, name: "Spring launch" });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

let root: Root | null = null;

async function settle(container: HTMLElement): Promise<void> {
  let previous = "";
  for (let turn = 0; turn < 12; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const current = container.textContent ?? "";
    if (current !== "" && current === previous) break;
    previous = current;
  }
}

async function renderSubmissions(): Promise<HTMLElement> {
  const { default: Page } =
    await import("@/app/(dashboard)/app/landing-pages/[id]/submissions/page");
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Page as React.ComponentType),
      ),
    );
  });
  // Flush in SEPARATE act() turns until the DOM settles — the same shape the
  // page harness uses. One combined turn leaves the queries pending and the
  // assertions would read a skeleton.
  await settle(container);
  return container;
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
});

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll("tbody tr"));
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`no ${text} button`);
  return button as HTMLButtonElement;
}

describe("landing page submissions", () => {
  it("renders one window of leads, not all 500", async () => {
    const container = await renderSubmissions();

    const rows = bodyRows(container);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(LEAD_COUNT);
    expect(rows[0]?.textContent).toContain("lead0@example.com");
    // The last row of page one, not the last lead in the response.
    expect(container.textContent).not.toContain(
      `lead${LEAD_COUNT - 1}@example.com`,
    );
    expect(container.textContent).toContain(`${LEAD_COUNT} leads`);
  });

  it("pages forward through the rest", async () => {
    const container = await renderSubmissions();
    const firstPageRows = bodyRows(container).length;

    await act(async () => {
      buttonByText(container, "Next").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    const rows = bodyRows(container);
    expect(rows).toHaveLength(firstPageRows);
    expect(rows[0]?.textContent).toContain(`lead${firstPageRows}@example.com`);
    expect(container.textContent).not.toContain("lead0@example.com");
  });

  it("keeps populated email and pathological metadata reachable and contained", async () => {
    const container = await renderSubmissions();
    const firstRow = bodyRows(container)[0] as HTMLTableRowElement;
    const email = firstRow.querySelector("a") as HTMLAnchorElement;
    const details = firstRow.querySelectorAll("td")[2] as HTMLTableCellElement;

    expect(email.textContent).toBe("lead0@example.com");
    expect(email.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(email.className).toContain("focus-visible:ring-2");
    email.focus();
    expect(document.activeElement).toBe(email);

    expect(details.textContent).toContain(LONG_METADATA);
    expect(details.className).toContain("[overflow-wrap:anywhere]");
    expect(
      container
        .querySelector('[role="region"]')
        ?.className.includes("overflow-x-auto"),
    ).toBe(true);
  });
});
