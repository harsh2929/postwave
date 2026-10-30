// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ImportSubscribersWizard } from "../../components/subscribers/ImportSubscribersWizard";
import {
  EMPTY_TEMPLATE_CREATE_DRAFT,
  TemplateCreateModal,
} from "../../components/templates/TemplateLibraryPrimitives";

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

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

describe("command task initial focus", () => {
  it("focuses the template name instead of the title-bar close control", () => {
    render(
      <TemplateCreateModal
        draft={EMPTY_TEMPLATE_CREATE_DRAFT}
        open
        operationActive={false}
        slugTouched={false}
        submitErr={null}
        submitting={false}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSlugTouched={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(document.activeElement?.id).toBe("tpl-new-name");
  });

  it("focuses the import file picker on a fresh routed wizard", () => {
    render(
      <ImportSubscribersWizard
        open
        onClose={vi.fn()}
        onCompleted={vi.fn()}
      />,
    );
    expect(document.activeElement?.textContent).toContain(
      "Choose a subscriber CSV",
    );
  });
});
