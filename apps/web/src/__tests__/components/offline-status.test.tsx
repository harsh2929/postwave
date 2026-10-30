// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// OfflineStatus is the client island on /offline — the page a user sees when
// the service worker has nothing cached. Nothing rendered it, so the whole
// point of the component (that it CHANGES when connectivity changes) was
// unverified, and a component that renders null forever would have looked
// identical to a working one.
//
// Falsifiable claims:
//   - online: says "back online" and offers Reload, which actually calls
//     location.reload
//   - offline: says "still offline", warns that the page's other buttons need
//     a connection, and offers "Try again" INSTEAD of Reload
//   - it reacts to the browser's online/offline events rather than reading
//     navigator once at mount
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "../pages/_harness";

function setOnLine(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

async function fireConnectivity(event: "online" | "offline"): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(event));
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  setOnLine(true);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("OfflineStatus", () => {
  it("reports the restored connection and reloads on demand", async () => {
    setOnLine(true);
    const reload = vi.fn();
    // window.location.reload would attempt a real navigation in happy-dom.
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: reload,
    });

    const { OfflineStatus } =
      await import("@/components/offline/offline-status");
    const { container, root } = await renderPage(OfflineStatus);
    try {
      const status = container.querySelector("[role='status']");
      // The live region is what announces the change to a screen reader;
      // without it the state flips silently.
      expect(status?.getAttribute("aria-live")).toBe("polite");
      expect(container.textContent).toContain("You're back online.");
      expect(container.textContent).toContain("Connection restored");

      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.map((b) => b.textContent)).toEqual(["Reload the page"]);

      await act(async () => {
        buttons[0]!.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      unmount(root);
    }
  });

  it("switches to the offline copy and the Try again control on an offline event", async () => {
    setOnLine(true);
    const { OfflineStatus } =
      await import("@/components/offline/offline-status");
    const { container, root } = await renderPage(OfflineStatus);
    try {
      expect(container.textContent).toContain("You're back online.");

      setOnLine(false);
      await fireConnectivity("offline");

      expect(container.textContent).toContain("You're still offline.");
      // Cached destinations can still work; the warning must distinguish
      // reading cached pages from writes that need the server.
      expect(container.textContent).toContain("Cached pages may still open");
      expect(
        [...container.querySelectorAll("button")].map((b) => b.textContent),
      ).toEqual(["Try again"]);

      // Re-check while still offline: the control must not lie about state.
      await act(async () => {
        container.querySelector("button")!.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(container.textContent).toContain("You're still offline.");

      // …and it recovers when the connection comes back.
      setOnLine(true);
      await fireConnectivity("online");
      expect(container.textContent).toContain("You're back online.");
    } finally {
      unmount(root);
    }
  });
});
