// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression: ConditionEditor rendered a DIFFERENT comparator than the one it
// would save. When the stored comparator was not in the current field kind's
// list it substituted `validComparators[0]` for display only — the AST kept the
// original — so pressing Save (or ⌘Enter) re-persisted the operator the user
// could not see, while the screen showed one they never chose.
//
// Reachable two ways, neither exotic:
//   * a custom field's type is changed (number → string) after a segment was
//     built with `gte`, so the stored operator no longer fits the new kind;
//   * ordinary page load — `fieldKindOf` falls back to "string" for any field
//     it cannot resolve, and custom/registry fields arrive from an async query,
//     so EVERY numeric/date custom-field rule mis-resolves until it settles.
//
// That second case is why the tempting fix (emit the correction) is wrong: it
// would rewrite valid segments during the loading window. The picker instead
// renders whatever is stored, so display and storage never disagree.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComparatorPicker } from "@/components/segments/comparator-picker";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function render(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host.querySelector("select") as HTMLSelectElement;
}

describe("ComparatorPicker", () => {
  it("offers the comparators for the field kind", async () => {
    const select = await render(
      <ComparatorPicker kind="date" value="gte" onChange={() => {}} />,
    );
    expect(select.value).toBe("gte");
    expect([...select.options].map((o) => o.value)).toContain("is_null");
  });

  it("still shows a stored comparator that is not in the kind's list", async () => {
    // A numeric rule whose field kind has not resolved yet reads as "string".
    const select = await render(
      <ComparatorPicker kind="string" value="gte" onChange={() => {}} />,
    );
    // The control must report what will be saved, not a substitute.
    expect(select.value).toBe("gte");
    expect([...select.options].map((o) => o.value)).toContain("gte");
  });

  it("labels the carried-over comparator legibly rather than as a raw token", async () => {
    const select = await render(
      <ComparatorPicker kind="string" value="gte" onChange={() => {}} />,
    );
    const opt = [...select.options].find((o) => o.value === "gte");
    expect(opt?.textContent).toBeTruthy();
    expect(opt?.textContent).not.toBe("gte");
  });

  it("reports the user's selection", async () => {
    const onChange = vi.fn();
    const select = await render(
      <ComparatorPicker kind="string" value="equals" onChange={onChange} />,
    );
    await act(async () => {
      select.value = "contains";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("contains");
  });
});
