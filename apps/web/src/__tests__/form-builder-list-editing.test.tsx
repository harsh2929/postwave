// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression: the form builder's two delimiter-separated editors normalised the
// user's raw text on EVERY keystroke and then fed the normalised result back as
// the controlled value. Because normalisation drops empty entries, the very
// keystroke that starts a new entry — Enter for options, "," for MIME types —
// produced a trailing empty entry, which was filtered out, which snapped the
// value back to what it was before the keystroke.
//
// The visible symptom: pressing Enter in "Options (one per line)" did nothing
// at all, so a second option could not be typed. Same for typing a comma in
// "Accepted file types". Both editors were unreachable by keyboard for their
// primary purpose while still looking perfectly correct in the source.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormBuilder } from "@/components/forms/form-builder";
import type { Form, FormField, FormStructure } from "@/lib/forms-types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function formWith(fields: FormField[]): Form {
  return {
    id: "f1",
    tenantId: "t1",
    slug: "signup",
    name: "Signup",
    optInMode: "single",
    structure: { fields },
    settings: { successMessage: "Thanks" },
    status: "draft",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

let latest: FormStructure | null = null;

function Harness({ initial }: { initial: FormField[] }) {
  const [structure, setStructure] = useState<FormStructure>({ fields: initial });
  return (
    <FormBuilder
      form={{ ...formWith(initial), structure }}
      onChange={(next) => {
        latest = next;
        setStructure(next);
      }}
    />
  );
}

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function mount(fields: FormField[]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness initial={fields} />);
  });
}

/** Drive a controlled input/textarea the way a real keystroke does. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("form builder delimiter-separated editors", () => {
  it("keeps the newline that starts a new option", async () => {
    await mount([
      {
        id: "r1",
        kind: "radio",
        label: "Choose one",
        required: false,
        options: [{ label: "Option 1" }, { label: "Option 2" }],
      },
    ]);

    const textarea = host!.querySelector<HTMLTextAreaElement>("#prop-options")!;
    expect(textarea.value).toBe("Option 1\nOption 2");

    // The user presses Enter at the end to begin a third option.
    await type(textarea, "Option 1\nOption 2\n");

    expect(textarea.value).toBe("Option 1\nOption 2\n");
  });

  it("keeps the comma that starts a new accepted MIME type", async () => {
    await mount([
      {
        id: "u1",
        kind: "file_upload",
        label: "Upload a file",
        required: false,
        acceptMime: ["application/pdf"],
      },
    ]);

    const input = host!.querySelector<HTMLInputElement>("#prop-accept")!;
    expect(input.value).toBe("application/pdf");

    // The user types "," to begin a second MIME type.
    await type(input, "application/pdf,");

    expect(input.value).toBe("application/pdf,");
  });

  it("does not persist a 0-byte upload cap when the size field is cleared", async () => {
    await mount([
      {
        id: "u1",
        kind: "file_upload",
        label: "Upload a file",
        required: false,
        maxBytes: 5_000_000,
      },
    ]);

    const input = host!.querySelector<HTMLInputElement>("#prop-max-bytes")!;
    expect(input.value).toBe("5000000");

    // Select-all + Delete to retype the number: the field goes empty first.
    await type(input, "");

    // The box must stay clearable...
    expect(input.value).toBe("");
    // ...but an empty box is not "accept a 0-byte file", which would reject
    // every upload the form could ever receive.
    expect(latest?.fields[0]?.maxBytes).not.toBe(0);

    // And retyping commits the new cap.
    await type(input, "8000000");
    expect(latest?.fields[0]?.maxBytes).toBe(8_000_000);
  });
});
