// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, StrictMode } from "react";
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

import type { InboundRouteMatch } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  copy: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { inboundRouteMatchesList: mocks.list },
  getApiUrl: () => "https://api.example.test",
}));

vi.mock("../../lib/clipboard", () => ({
  clipboardAnnouncement: (result: { ok: boolean }) =>
    result.ok ? "Provider snippet copied." : "Provider snippet copy failed.",
  writeClipboardText: mocks.copy,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import {
  MatchHistoryPanel,
  ProviderSnippetsCard,
} from "../../components/inbound/InboundRouteDiagnostics";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.copy.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "public",
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: null,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function rerender(node: ReactElement): void {
  act(() => root?.render(node));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

describe("MatchHistoryPanel request isolation", () => {
  it("accepts the current response after the Strict Mode effect replay", async () => {
    mocks.list.mockResolvedValue({
      data: { matches: [match("route-b", "current")] },
    });
    render(
      <StrictMode>
        <MatchHistoryPanel routeId="route-b" />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("current@example.com");
    });
    expect(mocks.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("never renders a late match from the previously selected route", async () => {
    const previous = deferred<{ data: { matches: InboundRouteMatch[] } }>();
    mocks.list.mockReturnValueOnce(previous.promise).mockResolvedValueOnce({
      data: { matches: [match("route-b", "current")] },
    });
    render(<MatchHistoryPanel routeId="route-a" />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    rerender(<MatchHistoryPanel routeId="route-b" />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("current@example.com");
    });
    await act(async () => {
      previous.resolve({
        data: { matches: [match("route-a", "previous-secret")] },
      });
      await previous.promise;
    });

    expect(document.body.textContent).not.toContain(
      "previous-secret@example.com",
    );
    expect(document.body.textContent).toContain("current@example.com");
  });

  it("shows complete match context with a controlled disclosure and no title-only values", async () => {
    mocks.list.mockResolvedValue({
      data: { matches: [match("route-b", "complete-reader")] },
    });
    render(<MatchHistoryPanel routeId="route-b" />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "complete-reader@example.com",
      );
    });
    expect(document.body.textContent).toContain("From:");
    expect(document.body.textContent).toContain("To:");
    expect(document.body.textContent).toContain("Subject:");
    expect(document.body.textContent).toContain("7/15/2026");
    const disclosure = document.querySelector<HTMLButtonElement>(
      ".inbound-match-summary",
    );
    expect(disclosure?.getAttribute("aria-controls")).toBeTruthy();
    expect(container?.querySelector("[title]")).toBeNull();
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains synchronous history failures and single-flights retry", async () => {
    mocks.list
      .mockImplementationOnce(() => {
        throw new Error("private inbound database detail");
      })
      .mockResolvedValueOnce({
        data: { matches: [match("route-b", "recovered")] },
      });
    render(<MatchHistoryPanel routeId="route-b" />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The service could not be reached. Check the connection and retry.",
      );
    });
    expect(document.body.textContent).not.toContain(
      "private inbound database detail",
    );
    const retry = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Retry history",
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("recovered@example.com");
  });

  it("single-flights provider snippet copy and announces the acknowledged result", async () => {
    const pending = deferred<{
      ok: true;
      backend: "web";
      contentClass: "public";
      clearScheduled: false;
      clearAfterMs: null;
      historyWarning: null;
    }>();
    mocks.copy.mockReturnValueOnce(pending.promise);
    render(<ProviderSnippetsCard slug="tenant-inbox" />);
    const copy = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Copy",
    );
    expect(copy).toBeTruthy();
    act(() => {
      copy?.click();
      copy?.click();
    });
    expect(mocks.copy).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Copying…");
    await act(async () => {
      pending.resolve({
        ok: true,
        backend: "web",
        contentClass: "public",
        clearScheduled: false,
        clearAfterMs: null,
        historyWarning: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Copied to clipboard");
    expect(document.body.textContent).toContain("Provider snippet copied.");
  });
});

function match(routeId: string, identity: string): InboundRouteMatch {
  return {
    id: routeId === "route-a" ? 1 : 2,
    route_id: routeId,
    recipient: "inbox@example.com",
    subject: `${identity} subject`,
    from_email: `${identity}@example.com`,
    matched_at: "2026-07-15T12:00:00.000Z",
  };
}
