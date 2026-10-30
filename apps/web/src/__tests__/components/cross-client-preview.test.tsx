// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossClientPreview } from "@/components/editor/cross-client-preview";
import type { RenderResponse } from "@/lib/render-types";

const mocks = vi.hoisted(() => ({ renderEmail: vi.fn() }));

vi.mock("@/lib/render-api", () => ({ renderEmail: mocks.renderEmail }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const outlookRender = {
  environment: {
    name: "outlook_2019_desktop",
    viewport_width: 900,
    viewport_height: 1200,
    user_agent: "Outlook 16",
    dark_mode: false,
  },
  image_url: "https://images.example.test/outlook.png",
  width: 900,
  height: 600,
  issues: [
    "border-radius is ignored in Outlook 2019",
    "Spacing may vary slightly",
  ],
};

const gmailRender = {
  environment: {
    name: "gmail_ios",
    viewport_width: 390,
    viewport_height: 844,
    user_agent: "Gmail iOS",
    dark_mode: false,
  },
  image_url: "javascript:alert(1)",
  width: 390,
  height: 422,
  issues: [],
};

const success: RenderResponse = {
  cache_hit: true,
  render_mode: "simulation",
  renders: [outlookRender, gmailRender],
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(ui: ReactNode): Promise<void> {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(ui));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolvePromise) =>
          window.setTimeout(resolvePromise, 0),
        );
      });
    }
  }
  throw lastError;
}

function button(name: string, last = false): HTMLButtonElement {
  const matches = Array.from(document.querySelectorAll("button")).filter(
    (candidate): candidate is HTMLButtonElement =>
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name,
  );
  const match = last ? matches.at(-1) : matches[0];
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

beforeEach(() => {
  mocks.renderEmail.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

describe("CrossClientPreview", () => {
  it("renders safe result cards and a focus-restoring full-size issue dialog", async () => {
    mocks.renderEmail.mockResolvedValue(success);
    await render(<CrossClientPreview html="<p>Hello</p>" debounceMs={0} />);
    expect(
      document.querySelector(
        '[role="status"][aria-label="Loading cross-client previews"]',
      ),
    ).not.toBeNull();
    await waitFor(() =>
      expect(
        button("Open Outlook 2019 (Desktop) preview full-size"),
      ).not.toBeNull(),
    );
    expect(document.body.textContent).toContain("cache hit");
    expect(document.body.textContent).toContain("Simulation · not a real inbox");
    expect(document.body.textContent).toContain("1 breaking");
    expect(document.body.textContent).toContain("1 warning");
    expect(document.body.textContent).toContain("Preview image unavailable.");

    const trigger = button("Open Outlook 2019 (Desktop) preview full-size");
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Outlook 2019 (Desktop)");
    expect(dialog?.textContent).toContain("900×1200 · Light mode");
    expect(dialog?.textContent).toContain("border-radius is ignored");
    expect(
      dialog?.querySelector(
        'img[alt="Full-size preview for Outlook 2019 (Desktop)"]',
      ),
    ).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);

    await act(async () => button("Close", true).click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps request failure distinct and retries into an explicit empty success", async () => {
    mocks.renderEmail
      .mockRejectedValueOnce(new Error("Renderer unavailable"))
      .mockResolvedValueOnce({ cache_hit: false, renders: [] });
    await render(<CrossClientPreview html="<p>Hello</p>" debounceMs={0} />);
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Renderer unavailable",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "No preview renders returned",
    );

    await act(async () => button("Retry previews").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No preview renders returned",
      ),
    );
    expect(mocks.renderEmail).toHaveBeenCalledTimes(2);
  });

  it("aborts and discards an older render when HTML changes", async () => {
    let resolveFirst: ((value: RenderResponse) => void) | undefined;
    let resolveSecond: ((value: RenderResponse) => void) | undefined;
    mocks.renderEmail
      .mockImplementationOnce(
        () =>
          new Promise<RenderResponse>((resolvePromise) => {
            resolveFirst = resolvePromise;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<RenderResponse>((resolvePromise) => {
            resolveSecond = resolvePromise;
          }),
      );

    await render(<CrossClientPreview html="<p>First</p>" debounceMs={0} />);
    await waitFor(() => expect(mocks.renderEmail).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.renderEmail.mock.calls[0]?.[2] as AbortSignal;
    await render(<CrossClientPreview html="<p>Second</p>" debounceMs={0} />);
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(mocks.renderEmail).toHaveBeenCalledTimes(2));

    const secondOnly: RenderResponse = {
      cache_hit: false,
      renders: [gmailRender],
    };
    await act(async () => resolveSecond?.(secondOnly));
    await waitFor(() =>
      expect(button("Open Gmail (iOS) preview full-size")).not.toBeNull(),
    );
    await act(async () => resolveFirst?.(success));
    expect(document.body.textContent).not.toContain("Outlook 2019 (Desktop)");
    expect(document.body.textContent).toContain("Gmail (iOS)");
  });

  it("invalidates an in-flight render when content becomes empty", async () => {
    let resolveRequest: ((value: RenderResponse) => void) | undefined;
    mocks.renderEmail.mockImplementationOnce(
      () =>
        new Promise<RenderResponse>((resolvePromise) => {
          resolveRequest = resolvePromise;
        }),
    );
    await render(<CrossClientPreview html="<p>First</p>" debounceMs={0} />);
    await waitFor(() => expect(mocks.renderEmail).toHaveBeenCalledTimes(1));
    const signal = mocks.renderEmail.mock.calls[0]?.[2] as AbortSignal;

    await render(<CrossClientPreview html="   " debounceMs={0} />);
    expect(signal.aborted).toBe(true);
    expect(document.body.textContent).toContain("No content to preview yet");
    await act(async () => resolveRequest?.(success));
    expect(document.body.textContent).not.toContain("Outlook 2019 (Desktop)");
  });
});
