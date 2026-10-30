// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SequenceBuilder } from "@/app/(dashboard)/app/sequences/new/_components/sequence-builder";
import {
  MAX_SEQUENCE_DRAFT_STEPS,
  MAX_SEQUENCE_NAME_CHARS,
  MAX_SEQUENCE_SUBJECT_CHARS,
  sequenceDraftKey,
  serializeSequenceDraft,
  type CanvasStep,
} from "@/app/(dashboard)/app/sequences/new/_components/sequence-builder-helpers";

import { renderPage, unmount } from "../pages/_harness";

const SCOPE = {
  tenantId: "tenant-sequence-test",
  userId: "user-sequence-test",
  canWriteCampaigns: true,
};

const mocks = vi.hoisted(() => ({
  createSequence: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("@/lib/auth-scope", () => ({
  useVerifiedAuthScopeOptional: () => SCOPE,
}));

vi.mock("@/lib/voice-api", () => ({
  createSequence: mocks.createSequence,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

function fieldByLabel<T extends HTMLInputElement | HTMLTextAreaElement>(
  container: HTMLElement,
  label: string,
): T {
  const match = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const field = match?.htmlFor ? document.getElementById(match.htmlFor) : null;
  if (
    !(field instanceof HTMLInputElement) &&
    !(field instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`Field not found: ${label}`);
  }
  return field as T;
}

async function changeField(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function fakeDataTransfer(initial = ""): DataTransfer {
  let value = initial;
  return {
    dropEffect: "none",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: initial ? ["text/plain"] : [],
    clearData: () => {
      value = "";
    },
    getData: () => value,
    setData: (_format: string, next: string) => {
      value = next;
    },
    setDragImage: () => {},
  };
}

function dispatchDrag(
  target: Element,
  type: "dragstart" | "dragend" | "dragover" | "drop",
  dataTransfer: DataTransfer,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
}

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.createSequence.mockResolvedValue({
    id: "sequence-created",
    status: "draft",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  window.sessionStorage.clear();
});

describe("manual sequence builder contracts", () => {
  it("blocks an email without a body and sends a server-legal draft", async () => {
    const { container, root } = await renderPage(SequenceBuilder);
    try {
      await act(async () => button(container, "Email").click());

      const subject = fieldByLabel<HTMLInputElement>(container, "Subject");
      const body = fieldByLabel<HTMLTextAreaElement>(container, "Body");
      const save = button(container, "Save sequence");
      expect(subject.hasAttribute("maxlength")).toBe(false);

      await changeField(subject, "A legal subject");
      expect(container.textContent).toContain("an email step needs a body");
      expect(save.disabled).toBe(true);
      expect(mocks.createSequence).not.toHaveBeenCalled();

      await changeField(body, "A complete email body.");
      expect(save.disabled).toBe(false);
      await act(async () => {
        save.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mocks.createSequence).toHaveBeenCalledTimes(1);
      expect(mocks.createSequence).toHaveBeenCalledWith({
        name: "Manual sequence",
        status: "draft",
        steps: [
          {
            type: "email",
            position: 1,
            email: {
              subject: "A legal subject",
              body: "A complete email body.",
              delay_seconds: 0,
            },
          },
        ],
      });
      expect(mocks.push).toHaveBeenCalledWith(
        "/app/sequences/sequence-created",
      );
    } finally {
      unmount(root);
    }
  });

  it("accepts valid rune-limit emoji names and subjects without truncation", async () => {
    const { container, root } = await renderPage(SequenceBuilder);
    try {
      await act(async () => button(container, "Email").click());
      const name = fieldByLabel<HTMLInputElement>(container, "Sequence name");
      const subject = fieldByLabel<HTMLInputElement>(container, "Subject");
      const body = fieldByLabel<HTMLTextAreaElement>(container, "Body");
      const validName = "🙂".repeat(MAX_SEQUENCE_NAME_CHARS);
      const validSubject = "🙂".repeat(MAX_SEQUENCE_SUBJECT_CHARS);

      expect(name.hasAttribute("maxlength")).toBe(false);
      expect(subject.hasAttribute("maxlength")).toBe(false);
      await changeField(name, validName);
      await changeField(subject, validSubject);
      await changeField(body, "A complete body");

      expect(name.value).toBe(validName);
      expect(subject.value).toBe(validSubject);
      const save = button(container, "Save sequence");
      expect(save.disabled).toBe(false);
      await act(async () => {
        save.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const request = mocks.createSequence.mock.calls[0]?.[0] as {
        name?: string;
        steps?: Array<{ email?: { subject?: string } }>;
      };
      expect(request.name).toBe(validName);
      expect(request.steps?.[0]?.email?.subject).toBe(validSubject);
    } finally {
      unmount(root);
    }
  });

  it("treats a name-only edit as dirty, autosaves it, and restores it", async () => {
    const storageKey = sequenceDraftKey(SCOPE);
    expect(storageKey).toBeTruthy();
    const first = await renderPage(SequenceBuilder);
    await changeField(
      fieldByLabel<HTMLInputElement>(first.container, "Sequence name"),
      "Lifecycle onboarding",
    );
    expect(first.container.textContent).toContain("Unsaved changes");
    expect(
      JSON.parse(window.sessionStorage.getItem(storageKey!) ?? "null"),
    ).toMatchObject({
      version: 1,
      name: "Lifecycle onboarding",
      steps: [],
    });
    unmount(first.root);

    const second = await renderPage(SequenceBuilder);
    try {
      expect(
        fieldByLabel<HTMLInputElement>(second.container, "Sequence name").value,
      ).toBe("Lifecycle onboarding");
      expect(second.container.textContent).toContain(
        "Restored your unsaved draft",
      );
      expect(second.container.textContent).not.toContain("Unsaved changes");
    } finally {
      unmount(second.root);
    }
  });

  it("clears an abandoned row drag so the next palette drop is accepted", async () => {
    const { container, root } = await renderPage(SequenceBuilder);
    try {
      await act(async () => {
        button(container, "Email").click();
        button(container, "Wait").click();
      });
      const canvas = container.querySelector('[data-testid="sequence-canvas"]');
      const firstRow = canvas?.querySelector("ol > li");
      const exitPalette = container.querySelector(
        '[data-testid="palette-step-exit"]',
      );
      if (!canvas || !firstRow || !exitPalette) {
        throw new Error("Sequence drag fixtures did not render");
      }

      const abandoned = fakeDataTransfer();
      await act(async () => {
        dispatchDrag(firstRow, "dragstart", abandoned);
        // Releasing outside the canvas still dispatches dragend at the source.
        dispatchDrag(firstRow, "dragend", abandoned);
      });

      const next = fakeDataTransfer("exit");
      await act(async () => {
        dispatchDrag(exitPalette, "dragstart", next);
        dispatchDrag(canvas, "dragover", next);
        dispatchDrag(canvas, "drop", next);
      });

      expect(canvas.querySelectorAll("ol > li")).toHaveLength(3);
      expect(container.textContent).toContain("Exit sequence");
    } finally {
      unmount(root);
    }
  });

  it("visibly disables every palette control at the 100-step cap", async () => {
    const storageKey = sequenceDraftKey(SCOPE);
    const steps: CanvasStep[] = Array.from(
      { length: MAX_SEQUENCE_DRAFT_STEPS },
      (_, index) => ({ id: `exit-${index}`, type: "exit" }),
    );
    window.sessionStorage.setItem(
      storageKey!,
      serializeSequenceDraft("At capacity", steps),
    );

    const { container, root } = await renderPage(SequenceBuilder);
    try {
      const palette = container.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="palette-step-"]',
      );
      expect(palette).toHaveLength(6);
      for (const control of palette) {
        expect(control.disabled).toBe(true);
        expect(control.className).toContain("disabled:cursor-not-allowed");
        expect(control.className).toContain("disabled:opacity-50");
      }
    } finally {
      unmount(root);
    }
  });
});
