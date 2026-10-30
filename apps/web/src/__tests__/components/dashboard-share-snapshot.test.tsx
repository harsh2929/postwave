// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-13: "Share snapshot" copies a plain-text summary of the loaded
// dashboard to the clipboard (desktop pages/Dashboard.tsx:168 +
// dashboard-snapshot.ts:52). Asserts the CONSEQUENCE — the exact text handed
// to navigator.clipboard.writeText, the rendered "Copied" outcome, a visible
// failure when the browser refuses the write, and that an incomplete payload
// withholds the control instead of copying fallback numbers.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.fn((_message: string) => undefined);
const toastError = vi.fn((_message: string) => undefined);
vi.mock("sonner", () => ({
  toast: {
    success: (message: string) => toastSuccess(message),
    error: (message: string) => toastError(message),
  },
}));

import type { DashboardStats } from "@/lib/analytics-api";
import {
  buildDashboardSnapshot,
  canBuildDashboardSnapshot,
  rateFromCounts,
} from "@/lib/dashboard-snapshot";
import { ShareSnapshotButton } from "@/components/dashboard/share-snapshot-button";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const STATS: DashboardStats = {
  subscribers_total: 12481,
  subscribers_added_30d: 300,
  subscribers_unsubbed_30d: 12,
  campaigns_sent_30d: 4,
  opens_total_30d: 9000,
  clicks_total_30d: 700,
  bounces_total_30d: 50,
  unique_opens_30d: 224,
  unique_clicks_30d: 31,
  unique_bounces_30d: 8,
  unique_delivered_30d: 1000,
  unique_sent_30d: 1000,
  previous: {
    subscribers_added: 152,
    unique_opens: 212,
    unique_clicks: 31,
    unique_bounces: 11,
    unique_delivered: 1000,
    unique_sent: 1000,
  },
};

const writeText = vi.fn(async (_text: string) => undefined);
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  writeText.mockReset();
  writeText.mockImplementation(async () => undefined);
  toastSuccess.mockClear();
  toastError.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(stats: DashboardStats | null) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(ShareSnapshotButton, { stats })));
  return host;
}

function button(el: HTMLElement): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) =>
    /Share snapshot|Copied|Copying/.test(b.textContent ?? ""),
  );
  if (!found) throw new Error("share button not rendered");
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("dashboard snapshot text", () => {
  it("renders rates from unique-recipient evidence with period deltas", () => {
    const text = buildDashboardSnapshot(STATS, {
      generatedAt: new Date("2026-09-12T10:00:00Z"),
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Moosewave — Last 30 days");
    expect(lines[1]).toBe("Subscribers: 12,481  +148");
    expect(lines[2]).toBe("Open rate:   22.4%   +1.2pt");
    expect(lines[3]).toBe("Click rate:  3.1%    —");
    expect(lines[4]).toBe("Bounce rate: 0.8%    -0.3pt");
  });

  it("never reports a rate above 100% or from a zero denominator", () => {
    expect(rateFromCounts(5, 4)).toBeNull();
    expect(rateFromCounts(1, 0)).toBeNull();
    expect(rateFromCounts(1.5, 4)).toBeNull();
    expect(rateFromCounts(1, 4)).toBe(0.25);
  });

  it("refuses a payload missing any distinct-recipient counter", () => {
    expect(canBuildDashboardSnapshot(STATS)).toBe(true);
    const partial = { ...STATS, unique_sent_30d: undefined };
    expect(canBuildDashboardSnapshot(partial)).toBe(false);
    expect(canBuildDashboardSnapshot(null)).toBe(false);
  });
});

describe("ShareSnapshotButton", () => {
  it("copies the built snapshot and confirms it", async () => {
    const el = render(STATS);
    await click(button(el));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain("Moosewave — Last 30 days");
    expect(copied).toContain("Subscribers: 12,481  +148");
    expect(copied).toContain("Open rate:   22.4%   +1.2pt");
    expect(button(el).textContent).toContain("Copied");
    expect(toastSuccess).toHaveBeenCalledWith(
      "Snapshot copied — paste it into Slack, Notion, or email.",
    );
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a refused clipboard write instead of swallowing it", async () => {
    writeText.mockImplementation(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const el = render(STATS);
    await click(button(el));
    expect(writeText).toHaveBeenCalledTimes(1);
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "The browser refused the clipboard write, so the snapshot was not copied. Try again.",
    );
    expect(button(el).textContent).toContain("Share snapshot");
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("withholds the control, with its reason, until complete metrics load", async () => {
    const el = render({ ...STATS, unique_delivered_30d: undefined });
    const control = button(el);
    expect(control.disabled).toBe(true);
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(el.querySelector(`[id="${describedBy}"]`)?.textContent).toBe(
      "Available once the complete performance metrics have loaded.",
    );
    await click(control);
    expect(writeText).not.toHaveBeenCalled();
  });
});
