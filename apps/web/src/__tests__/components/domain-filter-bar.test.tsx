// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// deliverability-3 — search / ownership-status filter / sort / clear over the
// custom-domain ownership registry. The component is driven directly because
// its host page (settings/domain/page.tsx) is another session's WIP. Every
// assertion is on what the operator would SEE: which hostnames render, in
// which order, the chip counts, and the "no matching" state naming the size
// of the untouched registry.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { DomainFilterBar } from "@/components/settings/DomainFilterBar";
import type { CustomDomain } from "@/lib/custom-domains-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function domain(
  id: string,
  host: string,
  verified: boolean,
  createdAt: string,
  purpose: CustomDomain["purpose"] = "links",
): CustomDomain {
  return {
    id,
    tenantId: "tenant-1",
    domain: host,
    purpose,
    verified,
    dns_records: [],
    createdAt,
  };
}

const DOMAINS: CustomDomain[] = [
  domain("d1", "links.alpha.test", true, "2026-01-01T00:00:00Z"),
  domain("d2", "forms.zeta.test", false, "2026-03-01T00:00:00Z", "forms"),
  domain("d3", "track.beta.test", false, "2026-02-01T00:00:00Z", "tracking"),
];

let root: Root | null = null;

function render(domains: CustomDomain[] = DOMAINS) {
  const container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <DomainFilterBar domains={domains}>
        {(visible) => (
          <ul aria-label="Visible hostnames">
            {visible.map((row) => (
              <li key={row.id}>{row.domain}</li>
            ))}
          </ul>
        )}
      </DomainFilterBar>,
    );
  });
  return container;
}

function visibleHosts(scope: ParentNode): string[] {
  return [
    ...scope.querySelectorAll('ul[aria-label="Visible hostnames"] li'),
  ].map((node) => node.textContent ?? "");
}

function chip(scope: ParentNode, label: string): HTMLButtonElement {
  const node = [
    ...scope.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Filter domains by ownership status"] button',
    ),
  ].find((candidate) => candidate.textContent?.startsWith(label));
  if (!node) throw new Error(`missing chip ${label}`);
  return node;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!node) throw new Error(`missing button ${label}`);
  return node;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("DomainFilterBar", () => {
  it("defaults to newest first and shows per-status counts", () => {
    const scope = render();
    expect(visibleHosts(scope)).toEqual([
      "forms.zeta.test",
      "track.beta.test",
      "links.alpha.test",
    ]);
    expect(chip(scope, "All").textContent).toBe("All3");
    expect(chip(scope, "Last check passed").textContent).toBe(
      "Last check passed1",
    );
    expect(chip(scope, "Needs DNS").textContent).toBe("Needs DNS2");
    expect(scope.textContent).toContain("Showing 3 of 3 registered domains.");
  });

  it("filters by ownership status", () => {
    const scope = render();
    act(() => chip(scope, "Needs DNS").click());
    expect(chip(scope, "Needs DNS").getAttribute("aria-pressed")).toBe("true");
    expect(visibleHosts(scope)).toEqual(["forms.zeta.test", "track.beta.test"]);

    act(() => chip(scope, "Last check passed").click());
    expect(visibleHosts(scope)).toEqual(["links.alpha.test"]);
  });

  it("searches hostnames and registration intent", () => {
    const scope = render();
    const search = scope.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    type(search, "BETA");
    expect(visibleHosts(scope)).toEqual(["track.beta.test"]);
    // Intent label, not the raw purpose id.
    type(search, "hosted forms");
    expect(visibleHosts(scope)).toEqual(["forms.zeta.test"]);
  });

  it("sorts by hostname, oldest, and needs-action-first", () => {
    const scope = render();
    const sort = scope.querySelector<HTMLSelectElement>("select")!;
    choose(sort, "domain");
    expect(visibleHosts(scope)).toEqual([
      "forms.zeta.test",
      "links.alpha.test",
      "track.beta.test",
    ]);
    choose(sort, "oldest");
    expect(visibleHosts(scope)).toEqual([
      "links.alpha.test",
      "track.beta.test",
      "forms.zeta.test",
    ]);
    choose(sort, "status");
    expect(visibleHosts(scope)).toEqual([
      "forms.zeta.test",
      "track.beta.test",
      "links.alpha.test",
    ]);
  });

  it("names the untouched registry when nothing matches, and Clear filters restores it", () => {
    const scope = render();
    act(() => chip(scope, "Last check passed").click());
    const search = scope.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    type(search, "zeta");

    expect(visibleHosts(scope)).toEqual([]);
    expect(scope.textContent).toContain("No matching hostnames");
    expect(scope.textContent).toContain("The underlying registry has 3 rows.");

    act(() => button(scope, "Clear filters").click());
    expect(visibleHosts(scope)).toHaveLength(3);
    expect(chip(scope, "All").getAttribute("aria-pressed")).toBe("true");
    expect(
      scope.querySelector<HTMLInputElement>('input[type="search"]')!.value,
    ).toBe("");
  });

  it("clears only the search from the inline control", () => {
    const scope = render();
    act(() => chip(scope, "Needs DNS").click());
    const search = scope.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    type(search, "zeta");
    expect(visibleHosts(scope)).toEqual(["forms.zeta.test"]);
    act(() => button(scope, "Clear domain search").click());
    expect(visibleHosts(scope)).toEqual(["forms.zeta.test", "track.beta.test"]);
  });
});
