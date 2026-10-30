// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// EmailPreview renders the multi-client preview (Gmail / Outlook / Apple Mail
// / dark). Nothing mounted it, so the tab→iframe mapping — the one thing the
// component does — was never checked: an off-by-one in
// `preview.previews[activeTab]` would show Gmail's HTML under the Outlook tab
// and look completely normal.
//
// Only the API client is replaced. EMAIL_CLIENTS stays real (via
// importOriginal), so the labels, descriptions and viewport widths asserted
// below are the ones production ships.
//
// Falsifiable claims:
//   - one tab per client, exactly one pressed
//   - the iframe shows the ACTIVE client's HTML at the ACTIVE client's width,
//     and is titled for it
//   - the sandbox stays `sandbox=""` — the security posture the file's header
//     comment is about, which a "fix" adding allow-same-origin would break
//   - warnings, API errors and the empty-MJML guard each surface
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "../pages/_harness";

const mocks = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock("@/lib/email-preview-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-preview-api")>()),
  renderEmailPreview: mocks.render,
}));

const MJML = "<mjml><mj-body><mj-text>Hello {{ first_name }}</mj-text></mj-body></mjml>";

const RESPONSE = {
  previews: {
    gmail: "<html><body>GMAIL BODY</body></html>",
    outlook: "<html><body>OUTLOOK BODY</body></html>",
    apple: "<html><body>APPLE BODY</body></html>",
    dark: "<html><body>DARK BODY</body></html>",
  },
  warnings: ["unmatched template variable: first_name"],
};

function iframe(container: HTMLElement): HTMLIFrameElement {
  return container.querySelector("iframe")!;
}

function tab(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  if (!found) throw new Error(`no control labelled ${label}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  mocks.render.mockReset();
  mocks.render.mockResolvedValue(RESPONSE);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EmailPreview", () => {
  it("renders each client's HTML under its own tab", async () => {
    const { EmailPreview } = await import("@/components/EmailPreview");
    const { container, root } = await renderPage(EmailPreview, {
      mjml: MJML,
      vars: { first_name: "Ada" },
    });
    try {
      // It fetches once on mount with the supplied MJML and vars.
      expect(mocks.render).toHaveBeenCalledTimes(1);
      expect(mocks.render).toHaveBeenCalledWith({
        mjml: MJML,
        vars: { first_name: "Ada" },
      });

      const tabs = [...container.querySelectorAll("button[aria-pressed]")];
      expect(tabs.map((b) => b.textContent)).toEqual([
        "Gmail web",
        "Outlook desktop",
        "Apple Mail (iOS)",
        "Dark mode",
      ]);
      expect(
        tabs.filter((b) => b.getAttribute("aria-pressed") === "true").length,
      ).toBe(1);

      // Gmail is the default: its HTML, its 600px viewport, its description.
      expect(iframe(container).getAttribute("srcdoc")).toBe(
        RESPONSE.previews.gmail,
      );
      expect(iframe(container).getAttribute("title")).toBe("Gmail web preview");
      expect(iframe(container).style.width).toBe("600px");
      expect(container.textContent).toContain("Strips <style>");

      // Switching tabs swaps all four of those together.
      await click(tab(container, "Apple Mail (iOS)"));
      expect(iframe(container).getAttribute("srcdoc")).toBe(
        RESPONSE.previews.apple,
      );
      expect(iframe(container).getAttribute("title")).toBe(
        "Apple Mail (iOS) preview",
      );
      expect(iframe(container).style.width).toBe("375px");
      expect(container.textContent).toContain("375px mobile viewport");
      expect(
        tab(container, "Apple Mail (iOS)").getAttribute("aria-pressed"),
      ).toBe("true");
      expect(tab(container, "Gmail web").getAttribute("aria-pressed")).toBe(
        "false",
      );
      // A tab change must not re-hit the API.
      expect(mocks.render).toHaveBeenCalledTimes(1);

      // The sandbox posture: no flags at all, so no scripts AND no
      // same-origin. Adding allow-same-origin here would re-open passive CSS
      // exfil with the parent's credentials.
      expect(iframe(container).getAttribute("sandbox")).toBe("");
      expect(iframe(container).getAttribute("referrerpolicy")).toBe(
        "no-referrer",
      );
    } finally {
      unmount(root);
    }
  });

  it("surfaces renderer warnings as a list", async () => {
    const { EmailPreview } = await import("@/components/EmailPreview");
    const { container, root } = await renderPage(EmailPreview, { mjml: MJML });
    try {
      const notes = container.querySelector("[role='status']");
      expect(notes?.textContent).toContain("Renderer notes");
      expect([...(notes?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual(
        RESPONSE.warnings,
      );
    } finally {
      unmount(root);
    }
  });

  it("shows the API's message when the render fails, and lets you retry", async () => {
    mocks.render.mockRejectedValueOnce(new Error("MJML parse error: line 3"));
    const { EmailPreview } = await import("@/components/EmailPreview");
    const { container, root } = await renderPage(EmailPreview, { mjml: MJML });
    try {
      const alert = container.querySelector("[role='alert']");
      expect(alert?.textContent).toBe("MJML parse error: line 3");
      // The iframe is still there, empty, rather than the component blanking.
      expect(iframe(container).getAttribute("srcdoc")).toBe("");

      // The refresh control is re-enabled and recovers.
      const refresh = tab(container, "Refresh preview");
      expect(refresh.disabled).toBe(false);
      await click(refresh);
      expect(container.querySelector("[role='alert']")).toBeNull();
      expect(iframe(container).getAttribute("srcdoc")).toBe(
        RESPONSE.previews.gmail,
      );
    } finally {
      unmount(root);
    }
  });

  it("does not call the API for empty MJML, and says why", async () => {
    const { EmailPreview } = await import("@/components/EmailPreview");
    const { container, root } = await renderPage(EmailPreview, { mjml: "   " });
    try {
      // Whitespace-only MJML must not auto-fetch — the comment in the source
      // says a request-per-keystroke would hammer the API.
      expect(mocks.render).not.toHaveBeenCalled();
      expect(container.querySelector("[role='alert']")).toBeNull();

      await click(tab(container, "Refresh preview"));
      expect(mocks.render).not.toHaveBeenCalled();
      expect(container.querySelector("[role='alert']")?.textContent).toBe(
        "MJML is empty.",
      );
    } finally {
      unmount(root);
    }
  });
});
