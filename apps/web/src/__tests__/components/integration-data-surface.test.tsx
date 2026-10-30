// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Plug } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DataSection,
  DataSurfaceHeader,
  DataSurfaceShell,
  QueryError,
  SectionSkeleton,
  StatusPill,
} from "@/components/integrations/data-surface";
import { DocsLink } from "@/components/integrations/docs-link";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("integration data-surface primitives", () => {
  it("provides a single page heading, named region, truthful states, and retry", () => {
    const retry = vi.fn();
    const { container, root } = render(
      <DataSurfaceShell>
        <DataSurfaceHeader
          icon={Plug}
          eyebrow="Data operations"
          title="Integration health"
          description="Inspect every connected surface."
        />
        <DataSection
          id="connection-health"
          title="Connection health"
          description="Measured provider state."
        >
          <StatusPill status="active" />
          <StatusPill status="failed" />
          <SectionSkeleton rows={2} />
          <QueryError
            title="Checks failed"
            description="No empty state was inferred."
            onRetry={retry}
          />
        </DataSection>
      </DataSurfaceShell>,
    );

    try {
      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(container.querySelector("h1")?.textContent).toBe(
        "Integration health",
      );
      const region = container.querySelector<HTMLElement>("[role='region']");
      expect(region?.getAttribute("aria-labelledby")).toBe("connection-health");
      expect(container.querySelector("#connection-health")?.tagName).toBe("H2");
      expect(container.querySelector("[role='status']")?.textContent).toContain(
        "Loading",
      );
      expect(container.querySelector("[role='alert']")?.textContent).toContain(
        "No empty state was inferred",
      );
      expect(container.textContent).toContain("active");
      expect(container.textContent).toContain("failed");

      const retryButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Try again",
      );
      act(() => retryButton?.click());
      expect(retry).toHaveBeenCalledTimes(1);

      // The authored descendant contract keeps the same mobile targets and
      // keyboard focus behavior without emitting a long Tailwind selector for
      // each descendant/variant combination on every route.
      expect(
        container.querySelector("[data-slot='page-shell']")?.className,
      ).toContain("pw-interaction-surface");
    } finally {
      act(() => root.unmount());
    }
  });

  it("opens only safe external docs in a new tab and rejects unsafe schemes", () => {
    const { container, root } = render(
      <div>
        <DocsLink href="https://docs.example.com/provider" />
        <DocsLink href="/docs/integrations">Internal docs</DocsLink>
        <DocsLink href="javascript:alert(1)">Unsafe docs</DocsLink>
        <DocsLink href="//evil.example/docs">Protocol relative</DocsLink>
      </div>,
    );

    try {
      const links = [...container.querySelectorAll("a")];
      expect(links).toHaveLength(2);
      expect(links[0]?.getAttribute("target")).toBe("_blank");
      expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
      expect(links[0]?.textContent).toContain("opens in a new tab");
      expect(links[1]?.getAttribute("target")).toBeNull();
      expect(container.textContent).not.toContain("Unsafe docs");
      expect(container.textContent).not.toContain("Protocol relative");
    } finally {
      act(() => root.unmount());
    }
  });
});
