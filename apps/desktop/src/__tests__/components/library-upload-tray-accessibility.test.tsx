// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  LibraryUploadTray,
  type UploadEntry,
} from "../../components/library/LibraryUploadTray";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const entries: UploadEntry[] = [
  {
    id: "active",
    filename: "campaign-hero.png",
    bytes: 2048,
    status: "uploading",
    progress: 0.1,
  },
  {
    id: "queued",
    filename: "footer.png",
    bytes: 1024,
    status: "queued",
    progress: 0,
  },
  {
    id: "failed",
    filename: "broken.png",
    bytes: 512,
    status: "failed",
    progress: 0,
    errorMessage: "Network unavailable",
  },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderTray(nextEntries = entries): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root?.render(
      <LibraryUploadTray
        entries={nextEntries}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        onClearAll={vi.fn()}
      />,
    ),
  );
}

describe("LibraryUploadTray accessibility", () => {
  it("keeps interactive controls outside status semantics and announces only a concise summary", async () => {
    renderTray();
    const tray = container?.querySelector("section.lib-upload-tray");
    expect(tray).not.toBeNull();
    expect(tray?.getAttribute("role")).toBeNull();
    expect(tray?.getAttribute("aria-labelledby")).toBeTruthy();

    const live = container?.querySelector('[role="status"]');
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.getAttribute("aria-atomic")).toBe("false");
    expect(live?.textContent).toContain("1 active, 1 queued, 1 failed");
    expect(live?.querySelector("button")).toBeNull();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("uses a named indeterminate progressbar and truthful phases rather than synthetic percentages", () => {
    renderTray();
    const progress = container?.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-label")).toBe(
      "Upload progress for campaign-hero.png",
    );
    expect(progress?.getAttribute("aria-valuetext")).toBe("Preparing");
    expect(progress?.hasAttribute("aria-valuenow")).toBe(false);
    expect(container?.textContent).not.toContain("10%");
    expect(container?.textContent).toContain("Preparing");

    renderTray(
      entries.map((entry) =>
        entry.id === "active" ? { ...entry, progress: 0.5 } : entry,
      ),
    );
    expect(
      container
        ?.querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuetext"),
    ).toBe("Uploading");
    expect(container?.textContent).not.toContain("50%");
  });

  it("names retry and dismissal controls with their file", () => {
    renderTray();
    expect(
      container?.querySelector(
        'button[aria-label="Retry upload of broken.png"]',
      ),
    ).not.toBeNull();
    expect(
      container?.querySelector(
        'button[aria-label="Dismiss upload of broken.png"]',
      ),
    ).not.toBeNull();
  });

  it("uses a paused placeholder instead of autoplaying an uploaded GIF thumbnail", () => {
    renderTray([
      {
        id: "gif",
        filename: "celebration.gif",
        bytes: 1024,
        status: "queued",
        progress: 0,
        thumbDataUrl: "blob:animated-gif",
        file: new File(["gif"], "celebration.gif", { type: "image/gif" }),
      },
    ]);
    expect(container?.querySelector("img")).toBeNull();
    expect(
      container?.querySelector(".lib-upload-gif-paused")?.textContent,
    ).toBe("GIF");
  });
});
