// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The docs Sidebar is the only navigation the documentation site has, and
// nothing rendered it. docs-navigation-semantics.test.tsx greps its SOURCE for
// `<h2` — which proves the string exists, not that the headings render, not
// that the filter narrows anything, and not that the group containing the page
// you are on opens.
//
// Mounted here with a realistic nav payload (two API tag groups, a skill
// category, migrations, integrations) supplied through the real
// DocsNavProvider, so the context contract is exercised rather than stubbed.
//
// Falsifiable claims:
//   - one landmark, four section headings, one row per nav item
//   - the API group containing the CURRENT pathname is expanded and the other
//     is not (this is `activeApiTag` + `defaultOpen`, the thing that makes the
//     sidebar usable on a 200-endpoint tree)
//   - typing in the filter narrows to matches and force-opens their groups
//   - a filter that matches nothing shows the no-matches message rather than
//     an empty sidebar
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "../pages/_harness";

const mocks = vi.hoisted(() => ({ pathname: "/docs/api/list-campaigns" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    // `prefetch` is a Link-only prop; forwarding it to a bare <a> makes React
    // warn about an unknown DOM attribute and tells us nothing.
    prefetch: _prefetch,
    ...props
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
  }) => createElement("a", { href, ...props }, children),
}));

const NAV = {
  apiGroups: [
    {
      tag: "Campaigns",
      items: [
        {
          slug: "list-campaigns",
          method: "get",
          path: "/api/v1/campaigns",
        },
        {
          slug: "create-campaign",
          method: "post",
          path: "/api/v1/campaigns",
        },
      ],
    },
    {
      tag: "Subscribers",
      items: [
        {
          slug: "list-subscribers",
          method: "get",
          path: "/api/v1/subscribers",
        },
      ],
    },
  ],
  skillGroups: [
    {
      category: "Messaging",
      items: [
        { slug: "send-campaign", name: "send_campaign" },
        { slug: "draft-broadcast", name: "draft_broadcast" },
      ],
    },
  ],
  migrationSources: [
    { slug: "mailchimp", name: "Mailchimp" },
    { slug: "klaviyo", name: "Klaviyo" },
  ],
  integrations: [{ slug: "shopify", name: "Shopify" }],
};

afterEach(() => {
  mocks.pathname = "/docs/api/list-campaigns";
  document.body.innerHTML = "";
});

async function mountSidebar(): Promise<{
  container: HTMLElement;
  root: import("react-dom/client").Root;
}> {
  const { Sidebar } = await import("@/components/docs/Sidebar");
  const { DocsNavProvider } = await import(
    "@/components/docs/docs-nav-context"
  );
  const Wrapper = (): JSX.Element => (
    <DocsNavProvider value={NAV}>
      <Sidebar />
    </DocsNavProvider>
  );
  const { container, root } = await renderPage(Wrapper);
  return { container, root };
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function filter(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    typeInto(input, value);
    await new Promise((r) => setTimeout(r, 0));
  });
}

function hrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll("a")].map(
    (a) => a.getAttribute("href") ?? "",
  );
}

describe("docs Sidebar", () => {
  it("renders one named landmark with all four section headings", async () => {
    const { container, root } = await mountSidebar();
    try {
      const nav = container.querySelector("nav");
      expect(nav?.getAttribute("aria-label")).toBe("Documentation sidebar");
      expect(
        [...container.querySelectorAll("h2")].map((h) => h.textContent),
      ).toEqual(["Get Started", "API", "Skills by category", "Guides"]);

      // The filter input must be labelled — it is an unadorned box otherwise.
      const input = container.querySelector("input");
      expect(input?.getAttribute("aria-label")).toBe(
        "Filter documentation navigation",
      );

      // Every group is offered, with its item count.
      const groupButtons = [...container.querySelectorAll("button")].filter(
        (b) => b.hasAttribute("aria-expanded"),
      );
      expect(groupButtons.map((b) => b.textContent)).toEqual([
        "Campaigns2",
        "Subscribers1",
        "Messaging2",
      ]);

      // Guides rows come from the supplied data, not from a hardcoded list.
      expect(hrefs(container)).toContain("/docs/migrations/mailchimp");
      expect(hrefs(container)).toContain("/docs/integrations/shopify");
      expect(container.textContent).toContain("Klaviyo");
    } finally {
      unmount(root);
    }
  });

  it("opens the API group holding the current page, and only that one", async () => {
    const { container, root } = await mountSidebar();
    try {
      // /docs/api/list-campaigns lives in the Campaigns tag group.
      expect(hrefs(container)).toContain("/docs/api/list-campaigns");
      expect(hrefs(container)).toContain("/docs/api/create-campaign");
      // The Subscribers group stays collapsed, so its endpoints are absent.
      expect(hrefs(container)).not.toContain("/docs/api/list-subscribers");

      const groupButtons = [...container.querySelectorAll("button")].filter(
        (b) => b.hasAttribute("aria-expanded"),
      );
      expect(
        groupButtons.map((b) => b.getAttribute("aria-expanded")),
      ).toEqual(["true", "false", "false"]);

      // The active row is styled distinctly from its sibling — the only
      // signal of "you are here" in a 200-row tree.
      const active = [...container.querySelectorAll("a")].find(
        (a) => a.getAttribute("href") === "/docs/api/list-campaigns",
      )!;
      const sibling = [...container.querySelectorAll("a")].find(
        (a) => a.getAttribute("href") === "/docs/api/create-campaign",
      )!;
      expect(active.className).not.toBe(sibling.className);
      expect(active.className).toContain("pw-ember");
    } finally {
      unmount(root);
    }
  });

  it("narrows to matching rows and force-opens their group while filtering", async () => {
    const { container, root } = await mountSidebar();
    try {
      await filter(container, "subscribers");

      const links = hrefs(container);
      // The match is shown even though its group was collapsed a moment ago.
      expect(links).toContain("/docs/api/list-subscribers");
      // …and the non-matching endpoints are gone.
      expect(links).not.toContain("/docs/api/create-campaign");
      expect(links).not.toContain("/docs/migrations/mailchimp");
      // Get Started has no "subscribers" row, so its heading drops entirely.
      expect(
        [...container.querySelectorAll("h2")].map((h) => h.textContent),
      ).not.toContain("Get Started");

      // Clearing restores the full tree.
      const clear = [...container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === "Clear filter",
      );
      expect(clear).toBeDefined();
      await act(async () => {
        clear!.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(hrefs(container)).toContain("/docs/migrations/mailchimp");
    } finally {
      unmount(root);
    }
  });

  it("does not offer a group toggle that cannot toggle while filtering", async () => {
    const { container, root } = await mountSidebar();
    try {
      const group = (): HTMLButtonElement =>
        [...container.querySelectorAll("button")].find(
          (b) =>
            b.hasAttribute("aria-expanded") &&
            b.textContent?.startsWith("Campaigns"),
        )! as HTMLButtonElement;

      await filter(container, "campaigns");

      // While the filter is on, `forceOpen` pins the group open: the button
      // cannot collapse it. It must therefore not present itself as an
      // operable disclosure — a screen reader reading only aria-expanded
      // would promise a control that does nothing.
      const toggle = group();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.getAttribute("aria-disabled")).toBe("true");
      expect(toggle.getAttribute("title")).toContain("clear the filter");

      // And pressing it really is a no-op — the matches stay on screen rather
      // than the filtered view collapsing out from under the user.
      await act(async () => {
        toggle.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(group().getAttribute("aria-expanded")).toBe("true");
      expect(hrefs(container)).toContain("/docs/api/list-campaigns");

      // Clearing the filter hands the control back: it is operable again, and
      // it collapses the group it claims to own.
      await filter(container, "");
      expect(group().hasAttribute("aria-disabled")).toBe(false);
      await act(async () => {
        group().click();
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(group().getAttribute("aria-expanded")).toBe("false");
      expect(hrefs(container)).not.toContain("/docs/api/list-campaigns");
    } finally {
      unmount(root);
    }
  });

  it("says so when a filter matches nothing", async () => {
    const { container, root } = await mountSidebar();
    try {
      await filter(container, "zzzznotathing");
      expect(container.textContent).toContain("No matches for");
      expect(container.textContent).toContain("zzzznotathing");
      // A silently-empty sidebar would also have zero links; the message is
      // what distinguishes "no results" from "the nav broke".
      expect(container.querySelectorAll("a").length).toBe(0);
    } finally {
      unmount(root);
    }
  });
});
