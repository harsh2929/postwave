import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page from "@/app/(docs)/docs/migrations/page";

describe("migration guide index capability boundaries", () => {
  it("separates billing handoffs and automation rebuilds from imports", () => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain("Stripe/Apple billing is a separate handoff");
    expect(html).toContain("membership metadata; live billing is separate");
    expect(html).toContain("sequence definitions need rebuild review");
    expect(html).toContain("Service Key or existing private-app token");
    expect(html).not.toContain("Subscribers, paid subs, post archive");
    expect(html).not.toContain("sequences with their emails");
  });
});
