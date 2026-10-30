// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PLAYGROUND_JSON_VIEW_BUDGET,
  PlaygroundJSONView,
} from "../../components/playground/PlaygroundJSONView";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

function render(node: ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

describe("PlaygroundJSONView bounded rendering", () => {
  it("preserves ordinary JSON disclosure semantics without a truncation claim", () => {
    const view = render(
      <PlaygroundJSONView value={{ ok: true, items: [1, 2] }} />,
    );

    expect(view.querySelector('[role="region"]')).not.toBeNull();
    expect(view.querySelector('[role="status"]')).toBeNull();
    expect(view.textContent).toContain('"ok":\u00a0true');
    expect(view.textContent).toContain('"items":\u00a0[');
  });

  it("caps a wide array at the deterministic node budget", () => {
    const extra = 50;
    const values = Array.from(
      { length: PLAYGROUND_JSON_VIEW_BUDGET.maxNodes + extra },
      (_, index) => index,
    );
    const view = render(<PlaygroundJSONView value={values} />);

    const notice = view.querySelector<HTMLElement>('[role="status"]');
    expect(notice?.textContent).toContain("bounded for safety");
    expect(notice?.textContent).toContain("1,000 values");
    expect(notice?.getAttribute("aria-live")).toBe("polite");
    expect(notice?.getAttribute("aria-atomic")).toBe("true");
    expect(view.querySelector(".play-json-omission")?.textContent).toContain(
      `${extra + 1} items omitted at the nodes limit`,
    );
    expect(view.querySelectorAll(".play-json-number")).toHaveLength(
      PLAYGROUND_JSON_VIEW_BUDGET.maxNodes - 1,
    );
  });

  it("bounds long keys and values and names each shortening accessibly", () => {
    const tail = "TAIL_MUST_NOT_RENDER";
    const longKey = `${"k".repeat(
      PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharactersPerValue + 20,
    )}${tail}`;
    const longValue = `${"v".repeat(
      PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharactersPerValue + 20,
    )}${tail}`;
    const view = render(
      <PlaygroundJSONView value={{ [longKey]: longValue }} />,
    );

    expect(view.textContent).not.toContain(tail);
    const markers = view.querySelectorAll<HTMLElement>(
      ".play-json-string-truncation",
    );
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.getAttribute("aria-label")).toMatch(
        /^String shortened from [\d,]+ characters$/,
      );
    }
  });

  it("enforces the aggregate string-character budget deterministically", () => {
    const chunk = "s".repeat(
      PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharactersPerValue,
    );
    const fullChunks = Math.floor(
      PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharacters /
        PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharactersPerValue,
    );
    const view = render(
      <PlaygroundJSONView
        value={Array.from({ length: fullChunks + 1 }, () => chunk)}
      />,
    );

    expect(view.querySelector('[role="status"]')?.textContent).toContain(
      `${PLAYGROUND_JSON_VIEW_BUDGET.maxStringCharacters.toLocaleString()} string characters`,
    );
    expect(view.querySelectorAll(".play-json-string")).toHaveLength(
      fullChunks + 1,
    );
    expect(view.querySelectorAll(".play-json-string-truncation")).toHaveLength(
      1,
    );
  });

  it("halts deterministic projection beyond the nested-depth budget", () => {
    let value: unknown = { leaf: "done" };
    for (
      let depth = 0;
      depth < PLAYGROUND_JSON_VIEW_BUDGET.maxDepth + 2;
      depth += 1
    ) {
      value = { next: value };
    }
    const view = render(<PlaygroundJSONView value={value} />);

    expect(view.querySelector('[role="status"]')?.textContent).toContain(
      `${PLAYGROUND_JSON_VIEW_BUDGET.maxDepth} nested levels`,
    );
    expect(view.textContent).not.toContain("done");
  });

  it("bounds non-JSON response text and preserves the original length notice", () => {
    const raw = "r".repeat(PLAYGROUND_JSON_VIEW_BUDGET.maxRawCharacters + 17);
    const view = render(
      <PlaygroundJSONView value={undefined} rawFallback={raw} />,
    );

    expect(view.querySelector('[role="status"]')?.textContent).toContain(
      `truncated after ${PLAYGROUND_JSON_VIEW_BUDGET.maxRawCharacters.toLocaleString()}`,
    );
    expect(view.querySelector("code")?.textContent).toHaveLength(
      PLAYGROUND_JSON_VIEW_BUDGET.maxRawCharacters,
    );
    expect(
      view
        .querySelector(".play-json-string-truncation")
        ?.getAttribute("aria-label"),
    ).toContain(
      (PLAYGROUND_JSON_VIEW_BUDGET.maxRawCharacters + 17).toLocaleString(),
    );
  });
});
