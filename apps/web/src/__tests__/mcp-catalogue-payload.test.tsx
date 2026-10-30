// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// RSC-04: /mcp imported the whole tool catalogue and handed it to a
// client component as props. Client props are serialized into the document's
// flight payload, so the page carried every tool name and description twice —
// once as rendered HTML and once as ~57 KB of JSON — so that a substring filter
// could run. A visitor who never opened the search box paid for all of it.
//
// The catalogue is now rendered once, on the server, and the filter island
// hides the rows already on the page. Pinned here: the island takes no
// catalogue (and cannot reach one), and the rows it filters are really there.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import McpPage from "@/app/(marketing)/mcp/page";
import { McpToolFilter } from "@/components/marketing/mcp-tool-filter";
import toolsData from "@/lib/mcp-tools.json";

import { renderPage, unmount } from "./pages/_harness";

const SRC = resolve(process.cwd(), "src");
const tools = toolsData as { name: string; category: string }[];

describe("/mcp catalogue payload", () => {
  it("has a catalogue big enough for a second copy to matter", () => {
    // Guard the guard.
    expect(tools.length).toBeGreaterThan(100);
  });

  it("gives the client island no catalogue to serialize", () => {
    const island = readFileSync(
      join(SRC, "components/marketing/mcp-tool-filter.tsx"),
      "utf8",
    );
    expect(island).not.toContain("mcp-tools.json");
    // Its only prop is a number.
    const page = readFileSync(
      join(SRC, "app/(marketing)/mcp/page.tsx"),
      "utf8",
    );
    expect(page).toContain("<McpToolFilter total={tools.length} />");
    expect(page).not.toMatch(/<McpToolFilter[^>]*tools=/);
  });

  it("server-renders every tool exactly once", () => {
    const html = renderToStaticMarkup(<McpPage />);
    expect((html.match(/data-mcp-tool/g) ?? []).length).toBe(tools.length);
    expect(html).toContain('id="mcp-tool-catalogue"');
    // A name appearing twice would mean the duplicate copy came back.
    const sample = tools[0]!.name;
    expect((html.match(new RegExp(`>${sample}<`, "g")) ?? []).length).toBe(1);
  });

  it("hides the server-rendered rows that do not match", async () => {
    // A miniature of the markup the page emits, so the island is exercised
    // against the contract it actually depends on.
    document.body.innerHTML = `
      <a data-mcp-chip="a" href="#cat-a"><span data-mcp-chip-count>2</span></a>
      <a data-mcp-chip="b" href="#cat-b"><span data-mcp-chip-count>1</span></a>
      <div id="mcp-tool-catalogue">
        <div data-mcp-category="a">
          <ul>
            <li data-mcp-tool><code>send_campaign</code><span>Send a campaign</span></li>
            <li data-mcp-tool><code>draft_broadcast</code><span>Draft a broadcast</span></li>
          </ul>
        </div>
        <div data-mcp-category="b">
          <ul>
            <li data-mcp-tool><code>list_subscribers</code><span>List subscribers</span></li>
          </ul>
        </div>
      </div>`;

    const { container, root } = await renderPage(() => (
      <McpToolFilter total={3} />
    ));
    try {
      const input = container.querySelector<HTMLInputElement>("input")!;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setter.call(input, "broadcast");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const rows = [
        ...document.querySelectorAll<HTMLElement>("[data-mcp-tool]"),
      ];
      expect(rows.map((r) => r.hidden)).toEqual([true, false, true]);
      // The category that lost everything, and its chip, are gone.
      expect(
        document.querySelector<HTMLElement>('[data-mcp-category="b"]')!.hidden,
      ).toBe(true);
      expect(
        document.querySelector<HTMLElement>('[data-mcp-chip="b"]')!.hidden,
      ).toBe(true);
      expect(
        document.querySelector('[data-mcp-chip="a"] [data-mcp-chip-count]')!
          .textContent,
      ).toBe("1");
      expect(container.textContent).toContain("1 of 3");

      // Clearing restores everything.
      await act(async () => {
        setter.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(
        [...document.querySelectorAll<HTMLElement>("[data-mcp-tool]")].map(
          (r) => r.hidden,
        ),
      ).toEqual([false, false, false]);
      expect(container.textContent).toContain("3 of 3");
    } finally {
      unmount(root);
      document.body.innerHTML = "";
    }
  });
});
