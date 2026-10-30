// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ApprovalSettings } from "../../components/ApprovalSettings";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderHold(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ApprovalSettings />));
  const hold = document.querySelector<HTMLElement>(
    "[data-testid='approval-settings-release-hold']",
  );
  if (!hold) throw new Error("Expected approval settings release hold");
  return hold;
}

describe("approval settings release hold", () => {
  it("stays static, explicit, and free of operational controls", () => {
    const hold = renderHold();

    expect(hold.textContent).toContain(
      "Delegation and escalation are unavailable",
    );
    expect(hold.textContent).toContain(
      "performs no approval-settings reads or writes",
    );
    expect(hold.textContent).toContain("Delegated authority");
    expect(hold.textContent).toContain("Escalation delivery");
    expect(hold.textContent).toContain("production RLS");
    expect(
      hold.querySelectorAll("button, input, select, textarea, form"),
    ).toHaveLength(0);
    expect(hold.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("has no serious or critical accessibility violations", async () => {
    const hold = renderHold();
    const result = await axe.run(hold, {
      rules: {
        "color-contrast": { enabled: false },
        region: { enabled: false },
      },
    });

    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
