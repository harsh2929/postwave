// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON,
  NoteAttachmentForm,
} from "../../components/subscriber/NoteAttachmentForm";

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

function renderForm(reason?: string): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<NoteAttachmentForm reason={reason} />));
}

describe("NoteAttachmentForm security gate", () => {
  it("exposes an explicit unavailable action without a chooser or registration form", () => {
    renderForm();

    const action = document.querySelector<HTMLButtonElement>("button");
    expect(action?.textContent).toContain("Attach file · Unavailable");
    expect(action?.disabled).toBe(true);
    const reasonId = action?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toBe(
      NOTE_ATTACHMENT_UPLOAD_UNAVAILABLE_REASON,
    );

    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.body.textContent).not.toContain("object-store key");
    expect(document.body.textContent).not.toContain("Choose local file");
  });

  it("renders a permission-specific reason without creating an enabled control", async () => {
    const reason =
      "Notes need an admin role. Secure note uploads are unavailable on this release.";
    renderForm(reason);

    const action = document.querySelector<HTMLButtonElement>("button");
    expect(action?.disabled).toBe(true);
    expect(document.body.textContent).toContain(reason);
    expect(document.querySelectorAll("button:not(:disabled)")).toHaveLength(0);

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
