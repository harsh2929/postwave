// @vitest-environment happy-dom

import axe from "axe-core";
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

import type { DmarcSourceDetail } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({ getDetail: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
  api: { getDmarcSourceDetail: mocks.getDetail },
}));

import { DmarcSourceSlideover } from "../../components/dmarc/DmarcSourceSlideover";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => mocks.getDetail.mockReset());

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function detail(ip: string): DmarcSourceDetail {
  return {
    sourceIp: ip,
    periodDays: 30,
    domain: "example.test",
    generatedAt: "2026-08-03T08:30:00.000Z",
    windowStart: "2026-07-04T08:30:00.000Z",
    windowEnd: "2026-08-03T08:30:00.000Z",
    hasMore: false,
    summary: {
      sourceIp: ip,
      messages: 10,
      dkimPass: 8,
      spfPass: 8,
      bothPass: 7,
      alignedPct: 0.9,
      primaryDisposition: "none",
      quarantined: 0,
      rejected: 0,
    },
    perReport: [
      {
        reportId: "22222222-2222-4222-8222-222222222222",
        orgName: "Mailbox Example",
        dateBegin: "2026-08-01T00:00:00.000Z",
        dateEnd: "2026-08-02T00:00:00.000Z",
        messages: 10,
        dkimPass: 8,
        spfPass: 8,
        bothPass: 7,
        alignedPct: 0.9,
        primaryDisposition: "none",
      },
    ],
  };
}

function view(ip = "192.0.2.1", onClose = vi.fn()): ReactElement {
  return (
    <DmarcSourceSlideover
      ip={ip}
      domain="example.test"
      days={30}
      onClose={onClose}
    />
  );
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return { rerender: (next) => act(() => root?.render(next)) };
}

async function settle(): Promise<void> {
  await act(async () => Promise.resolve());
}

describe("DmarcSourceSlideover", () => {
  it("uses the named shared slideover and exposes honest loading/data states", async () => {
    mocks.getDetail.mockResolvedValue({ data: detail("192.0.2.1") });
    render(view());
    expect(
      document.querySelector('[role="status"][aria-busy="true"]'),
    ).not.toBeNull();
    await settle();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toContain("192.0.2.1");
    expect(dialog?.textContent).toContain("90.0%");
    expect(dialog?.textContent).toContain("Mailbox Example");
    const result = await axe.run(dialog!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("contains thrown requests and retries without losing context", async () => {
    mocks.getDetail
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValueOnce({ data: detail("192.0.2.1") });
    render(view());
    await settle();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Check connectivity and try again",
    );
    expect(document.body.textContent).not.toContain("gateway unavailable");
    const retry = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Retry",
    );
    act(() => retry?.click());
    expect(document.activeElement?.getAttribute("role")).toBe("note");
    await settle();
    expect(mocks.getDetail).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(
      "Check connectivity and try again",
    );
    expect(document.body.textContent).toContain("10");
  });

  it("rejects late data after the requested source changes", async () => {
    const first = deferred<{ data: DmarcSourceDetail }>();
    const second = deferred<{ data: DmarcSourceDetail }>();
    mocks.getDetail
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const rendered = render(view("192.0.2.1"));
    rendered.rerender(view("198.51.100.2"));
    await act(async () => {
      first.resolve({ data: detail("192.0.2.1") });
      await first.promise;
    });
    expect(document.body.textContent).not.toContain("90.0%");
    await act(async () => {
      second.resolve({ data: detail("198.51.100.2") });
      await second.promise;
    });
    expect(document.body.textContent).toContain("198.51.100.2");
    expect(document.body.textContent).toContain("90.0%");
  });

  it("withholds malformed source payloads instead of inventing zero evidence", async () => {
    mocks.getDetail.mockResolvedValue({
      data: { ...detail("192.0.2.1"), generatedAt: "not-a-timestamp" },
    });
    render(view());
    await settle();
    expect(document.body.textContent).toContain("Source response withheld");
    expect(document.body.textContent).toContain(
      "No source metrics have been inferred",
    );
    expect(document.body.textContent).not.toContain("90.0%");
    expect(
      document.querySelector('[aria-label="Source message summary"]'),
    ).toBeNull();
  });
});
