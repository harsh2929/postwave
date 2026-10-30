// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  previewTransforms: vi.fn(),
  updateDedupe: vi.fn(),
  updatePii: vi.fn(),
  updateTransforms: vi.fn(),
}));

vi.mock("@/lib/data-hygiene-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data-hygiene-api")>()),
  previewIdentifierTransforms: mocks.previewTransforms,
  updateDeduplicationSettings: mocks.updateDedupe,
  updateIdentifierTransforms: mocks.updateTransforms,
  updatePiiFields: mocks.updatePii,
}));

import {
  DeduplicationThresholdEditor,
  IdentifierTransformsEditor,
  PiiFieldsEditor,
} from "@/app/(dashboard)/app/data-hygiene/data-hygiene-controls";
import type { IdentifierTransforms, PiiConfig } from "@/lib/data-hygiene-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialTransforms: IdentifierTransforms = {
  email_normalize_dots: false,
  email_normalize_plus: false,
  phone_e164_format: true,
  phone_default_region: "US",
};

const initialPii: PiiConfig = {
  built_in_fields: ["email", "phone"],
  fields: [
    {
      field_name: "government_identifier",
      sensitive: true,
      built_in: false,
    },
  ],
};

let roots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return container;
}

function button(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function dialog(): HTMLElement {
  const match = document.querySelector('[role="dialog"]');
  if (!(match instanceof HTMLElement)) throw new Error("Dialog not found");
  return match;
}

function setControlValue(control: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

beforeEach(() => {
  mocks.updateTransforms.mockResolvedValue(initialTransforms);
  mocks.previewTransforms.mockResolvedValue({
    config: initialTransforms,
    email_input: "J.o.h.n+promo@Gmail.com",
    email_output: "j.o.h.n+promo@gmail.com",
    email_changed: true,
    phones: [
      {
        key: "phone",
        input: "(202) 555-0147",
        output: "+12025550147",
        changed: true,
      },
    ],
  });
  mocks.updateDedupe.mockResolvedValue({
    merge_confidence_threshold: 0.9,
  });
  mocks.updatePii.mockResolvedValue({
    ...initialPii,
    fields: [{ ...initialPii.fields[0], sensitive: false }],
  });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

const runAdmin = <T,>(operation: (signal: AbortSignal) => Promise<T>) =>
  operation(new AbortController().signal);

describe("mounted data-hygiene parity controls", () => {
  it("lets an owner edit and save transforms, then dry-run the saved draft", async () => {
    const saved = { ...initialTransforms, email_normalize_plus: true };
    mocks.updateTransforms.mockResolvedValue(saved);
    mocks.previewTransforms.mockResolvedValue({
      config: saved,
      email_input: "J.o.h.n+promo@Gmail.com",
      email_output: "j.o.h.n@gmail.com",
      email_changed: true,
      phones: [],
    });
    const onSaved = vi.fn();
    render(
      <IdentifierTransformsEditor
        runAdmin={runAdmin}
        value={initialTransforms}
        canWrite
        permissionKnown
        resetVersion={0}
        onSaved={onSaved}
        onDirtyChange={vi.fn()}
      />,
    );

    const plusToggle = document.getElementById("normalize-email-plus");
    expect(plusToggle).toBeInstanceOf(HTMLInputElement);
    act(() => (plusToggle as HTMLInputElement).click());
    expect(button("Save transforms").disabled).toBe(false);
    await act(async () => button("Save transforms").click());
    await waitFor(() =>
      expect(mocks.updateTransforms).toHaveBeenCalledTimes(1),
    );
    expect(mocks.updateTransforms).toHaveBeenCalledWith(
      saved,
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
    expect(onSaved).toHaveBeenCalledWith(saved);

    await act(async () => button("Preview changes").click());
    await waitFor(() =>
      expect(mocks.previewTransforms).toHaveBeenCalledTimes(1),
    );
    expect(mocks.previewTransforms).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: saved }),
    );
    expect(document.body.textContent).toContain("j.o.h.n@gmail.com");
  });

  it("fails closed for a viewer while keeping the read-only dry-run available", () => {
    render(
      <IdentifierTransformsEditor
        runAdmin={runAdmin}
        value={initialTransforms}
        canWrite={false}
        permissionKnown
        resetVersion={0}
        onSaved={vi.fn()}
        onDirtyChange={vi.fn()}
      />,
    );

    expect(
      (document.getElementById("normalize-email-plus") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(document.querySelector("button")?.textContent).toContain(
      "Preview changes",
    );
    expect(document.body.textContent).toContain(
      "Only workspace owners and admins",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Save transforms",
      ),
    ).toBe(false);
    expect(mocks.updateTransforms).not.toHaveBeenCalled();
  });

  it("does not write a destructive threshold change before confirmation and supports retry", async () => {
    mocks.updateDedupe
      .mockRejectedValueOnce(new Error("Threshold service unavailable."))
      .mockResolvedValueOnce({ merge_confidence_threshold: 0.9 });
    const onSaved = vi.fn();
    render(
      <DeduplicationThresholdEditor
        runAdmin={runAdmin}
        value={{ merge_confidence_threshold: 0.95 }}
        canWrite
        permissionKnown
        resetVersion={0}
        onSaved={onSaved}
        onDirtyChange={vi.fn()}
      />,
    );

    const range = document.getElementById("dedupe-threshold");
    expect(range).toBeInstanceOf(HTMLInputElement);
    act(() => setControlValue(range as HTMLInputElement, "90"));
    expect(document.body.textContent).toContain(
      "can merge more distinct people",
    );
    act(() => button("Save threshold").click());
    expect(mocks.updateDedupe).not.toHaveBeenCalled();

    await act(async () => button("Save threshold", dialog()).click());
    await waitFor(() =>
      expect(dialog().textContent).toContain("Threshold service unavailable."),
    );
    expect(mocks.updateDedupe).toHaveBeenCalledTimes(1);

    await act(async () => button("Save threshold", dialog()).click());
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(mocks.updateDedupe).toHaveBeenNthCalledWith(
      2,
      0.9,
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
    expect(onSaved).toHaveBeenCalledWith({
      merge_confidence_threshold: 0.9,
    });
  });

  it("locks built-ins, confirms privacy reductions, and applies protective masking directly", async () => {
    function PiiHarness() {
      const [config, setConfig] = useState(initialPii);
      return (
        <PiiFieldsEditor
          runAdmin={runAdmin}
          value={config}
          canWrite
          permissionKnown
          onSaved={setConfig}
        />
      );
    }
    render(<PiiHarness />);

    const locked = button("Locked masked");
    expect(locked.disabled).toBe(true);
    act(() => button("Allow in AI").click());
    expect(mocks.updatePii).not.toHaveBeenCalled();
    await act(async () => button("Allow raw values", dialog()).click());
    await waitFor(() => expect(mocks.updatePii).toHaveBeenCalledTimes(1));
    expect(mocks.updatePii).toHaveBeenNthCalledWith(
      1,
      [{ field_name: "government_identifier", sensitive: false }],
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );

    await waitFor(() => expect(button("Mask from AI")).toBeTruthy());
    mocks.updatePii.mockResolvedValueOnce(initialPii);
    await act(async () => button("Mask from AI").click());
    await waitFor(() => expect(mocks.updatePii).toHaveBeenCalledTimes(2));
    expect(mocks.updatePii).toHaveBeenNthCalledWith(
      2,
      [{ field_name: "government_identifier", sensitive: true }],
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
  });
});
