// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AffiliatesQualificationWorkspace } from "../../components/affiliates/AffiliatesQualificationWorkspace";
import {
  AFFILIATE_ADMIN_INSPECTION_AVAILABLE,
  AFFILIATE_ADMIN_MUTATIONS_AVAILABLE,
  AFFILIATE_ATTRIBUTION_ACCRUAL_AVAILABLE,
  AFFILIATE_PAYOUT_OPERATIONS_AVAILABLE,
  AFFILIATE_PUBLIC_OFFER_AVAILABLE,
} from "../../lib/affiliate-operational-availability";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

function renderWorkspace(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<AffiliatesQualificationWorkspace />));
}

function tabs(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
}

describe("Affiliates qualification workspace", () => {
  it("keeps every commercial and financial operation fail-closed", () => {
    expect(AFFILIATE_ADMIN_INSPECTION_AVAILABLE).toBe(false);
    expect(AFFILIATE_ADMIN_MUTATIONS_AVAILABLE).toBe(false);
    expect(AFFILIATE_PUBLIC_OFFER_AVAILABLE).toBe(false);
    expect(AFFILIATE_ATTRIBUTION_ACCRUAL_AVAILABLE).toBe(false);
    expect(AFFILIATE_PAYOUT_OPERATIONS_AVAILABLE).toBe(false);
  });

  it("renders truthfully without contacting an affiliate API", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderWorkspace();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Release held");
    expect(document.body.textContent).toContain("No enrollment, tracking");
    expect(document.body.textContent).toContain("Operations held");
    expect(document.body.textContent).not.toContain("New affiliate");
    expect(document.body.textContent).not.toContain("Create payout");
  });

  it("implements automatic, roving keyboard tab activation", () => {
    renderWorkspace();
    const items = tabs();

    expect(items).toHaveLength(4);
    expect(items[0]?.getAttribute("aria-selected")).toBe("true");
    expect(items[0]?.tabIndex).toBe(0);
    expect(items[1]?.tabIndex).toBe(-1);

    act(() => {
      items[0]?.focus();
      items[0]?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
        }),
      );
    });

    expect(items[1]?.getAttribute("aria-selected")).toBe("true");
    expect(items[1]?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(items[1]);
    expect(document.body.textContent).toContain(
      "Credit only what can be explained later.",
    );

    act(() => {
      items[1]?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "End" }),
      );
    });

    expect(items[3]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(items[3]);
    expect(document.body.textContent).toContain(
      "Preview exactly what will move.",
    );
  });

  it("has no serious or critical automated accessibility violations", async () => {
    renderWorkspace();
    const results = await axe.run(container!, {
      resultTypes: ["violations"],
    });
    const severe = results.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
    expect(severe).toEqual([]);
  });
});
