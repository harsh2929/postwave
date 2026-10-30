// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// MarketingMobileNav had NEITHER a test of its own NOR a page that renders it
// in any test, so the whole component — the disclosure, the focus move, the
// body-scroll lock, the Escape handler — was unexercised. It is also the only
// way to reach the marketing nav on a phone, so a crash here is a site with no
// navigation on more than half its traffic.
//
// What each assertion pins:
//   - closed state: exactly one control, correctly named and aria-expanded=false
//   - open state: one link PER supplied item plus "Sign in" — a `.map` that
//     drops or duplicates an entry fails here
//   - Escape closes and the body scroll lock is released (a leaked
//     `overflow: hidden` freezes the page behind it)
import { act } from "react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clickEveryControl, renderPage, unmount } from "../pages/_harness";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => createElement("a", { href, ...props }, children),
}));

const PRODUCT_LINKS = [
  { href: "/product/campaigns", label: "Campaigns" },
  { href: "/product/automation", label: "Automation" },
  { href: "/product/sms", label: "SMS" },
  { href: "/product/analytics", label: "Analytics" },
];

const PRIMARY_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/vs", label: "Compare" },
];

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("MarketingMobileNav", () => {
  it("is a named, collapsed disclosure before it is opened", async () => {
    const { MarketingMobileNav } = await import(
      "@/components/marketing/mobile-nav"
    );
    const { container, root } = await renderPage(MarketingMobileNav, {
      primaryLinks: PRIMARY_LINKS,
      productLinks: PRODUCT_LINKS,
    });
    try {
      const trigger = container.querySelector("button");
      expect(trigger).not.toBeNull();
      // An icon-only button with no accessible name is unreachable by voice
      // control and unannounced by a screen reader.
      expect(trigger?.getAttribute("aria-label")).toBe("Open navigation");
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      // aria-controls must point at something once expanded; the id is
      // generated, so assert only that the attribute is present and non-empty.
      expect(trigger?.getAttribute("aria-controls")).toBeTruthy();
      // Nothing is disclosed yet.
      expect(container.querySelector("[role='dialog']")).toBeNull();
      expect(container.querySelectorAll("a").length).toBe(0);
    } finally {
      unmount(root);
    }
  });

  it("discloses one link per supplied item, plus Sign in", async () => {
    const { MarketingMobileNav } = await import(
      "@/components/marketing/mobile-nav"
    );
    const { container, root } = await renderPage(MarketingMobileNav, {
      primaryLinks: PRIMARY_LINKS,
      productLinks: PRODUCT_LINKS,
    });
    try {
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);

      const panel = container.querySelector("[role='dialog']");
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("aria-modal")).toBe("true");
      expect(panel?.getAttribute("aria-label")).toBe("Site navigation");

      const hrefs = [...container.querySelectorAll("a")].map((a) =>
        a.getAttribute("href"),
      );
      // Every supplied link, in both groups, plus the hardcoded Sign in.
      for (const item of [...PRODUCT_LINKS, ...PRIMARY_LINKS]) {
        expect(hrefs).toContain(item.href);
      }
      expect(hrefs).toContain("/login");
      expect(hrefs.length).toBe(
        PRODUCT_LINKS.length + PRIMARY_LINKS.length + 1,
      );
      expect(container.textContent).toContain("Campaigns");
      expect(container.textContent).toContain("Sign in");

      // The trigger renames itself while open.
      expect(
        container.querySelector("button")?.getAttribute("aria-label"),
      ).toBe("Close navigation");
      // Body scroll is locked so the page behind cannot scroll.
      expect(document.body.style.overflow).toBe("hidden");
      // Focus lands inside the panel, on its first link — otherwise a
      // keyboard user tabs through the whole page behind the modal first.
      expect(document.activeElement?.getAttribute("href")).toBe(
        PRODUCT_LINKS[0]!.href,
      );
    } finally {
      unmount(root);
    }
  });

  it("closes on Escape and releases the body scroll lock", async () => {
    const { MarketingMobileNav } = await import(
      "@/components/marketing/mobile-nav"
    );
    const { container, root } = await renderPage(MarketingMobileNav, {
      primaryLinks: PRIMARY_LINKS,
      productLinks: PRODUCT_LINKS,
    });
    try {
      await clickEveryControl(container);
      expect(container.querySelector("[role='dialog']")).not.toBeNull();

      await press("Escape");

      expect(container.querySelector("[role='dialog']")).toBeNull();
      expect(container.querySelectorAll("a").length).toBe(0);
      // A leaked lock leaves the whole site unscrollable after one tap.
      expect(document.body.style.overflow).toBe("");
    } finally {
      unmount(root);
    }
  });
});
