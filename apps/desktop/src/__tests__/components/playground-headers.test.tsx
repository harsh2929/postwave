// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CustomHeadersEditor,
  PLAYGROUND_CUSTOM_HEADER_NAME_MAX_LENGTH,
  PLAYGROUND_CUSTOM_HEADER_MAX_ROWS,
  PLAYGROUND_CUSTOM_HEADER_VALUE_MAX_LENGTH,
  ResponseHeadersTable,
} from "../../components/playground/PlaygroundHeaders";

vi.mock("../../components/playground/Copy", () => ({
  CopyButton: ({ label }: { label?: string }) => (
    <button type="button">Copy {label}</button>
  ),
}));

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
  vi.clearAllMocks();
});

function render(element: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(element));
}

describe("API Playground headers", () => {
  it("caps custom-header inputs before byte validation", () => {
    render(
      <CustomHeadersEditor
        rows={[{ key: "Accept", value: "application/json" }]}
        onChange={vi.fn()}
        idempotencyKey=""
        onRegenIdempotency={vi.fn()}
        showIdempotency={false}
      />,
    );
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Header name 1"]')
        ?.maxLength,
    ).toBe(PLAYGROUND_CUSTOM_HEADER_NAME_MAX_LENGTH);
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="Header value 1"]')
        ?.maxLength,
    ).toBe(PLAYGROUND_CUSTOM_HEADER_VALUE_MAX_LENGTH);
  });

  it("masks sensitive values again before a changed response can render", () => {
    render(
      <ResponseHeadersTable
        headers={{
          Authorization: "Bearer first-secret",
          "X-Request-Id": "req-1",
        }}
      />,
    );
    expect(document.body.textContent).not.toContain("first-secret");
    expect(document.body.textContent).toContain("req-1");

    const reveal = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Reveal Authorization",
    );
    act(() => reveal?.click());
    expect(document.body.textContent).toContain("first-secret");

    render(
      <ResponseHeadersTable
        headers={{
          Authorization: "Bearer next-secret",
          "X-Request-Id": "req-2",
        }}
      />,
    );
    expect(document.body.textContent).not.toContain("next-secret");
    expect(document.body.textContent).toContain("Reveal Authorization");
  });

  it("caps custom-header rows at the request planner boundary", () => {
    const onChange = vi.fn();
    render(
      <CustomHeadersEditor
        rows={Array.from(
          { length: PLAYGROUND_CUSTOM_HEADER_MAX_ROWS },
          (_, index) => ({
            key: "Accept",
            value: `application/json; q=${index}`,
          }),
        )}
        onChange={onChange}
        idempotencyKey=""
        onRegenIdempotency={vi.fn()}
        showIdempotency={false}
      />,
    );

    const add = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add header"),
    ) as HTMLButtonElement | undefined;
    expect(add?.disabled).toBe(true);
    act(() => add?.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      `${PLAYGROUND_CUSTOM_HEADER_MAX_ROWS}/${PLAYGROUND_CUSTOM_HEADER_MAX_ROWS}`,
    );
  });
});
