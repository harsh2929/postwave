// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivateFlowDialog } from "@/app/(dashboard)/app/flows/_components/activate-flow-dialog";
import { FlowActivationStatus } from "@/app/(dashboard)/app/flows/_components/flow-activation-status";
import { FlowListCard } from "@/app/(dashboard)/app/flows/_components/flow-list-card";
import {
  FLOW_ACTIVATION_RELEASE_HOLD,
  flowsApi,
  type Flow,
} from "@/lib/flows-api";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function flow(): Flow {
  return {
    id: "flow_1",
    name: "Welcome journey",
    status: "draft",
    version: 3,
    graph: { nodes: [], edges: [], triggers: [] },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  };
}

function render(ui: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return { container, root };
}

function card(
  patch: Partial<Parameters<typeof FlowListCard>[0]> = {},
): ReactNode {
  return createElement(FlowListCard, {
    flow: flow(),
    triggerCatalog: [],
    pinned: false,
    onTogglePin: vi.fn(),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDuplicate: vi.fn(),
    onArchive: vi.fn(),
    onCopyLink: vi.fn(),
    tags: ["existing"],
    onSetTags: vi.fn(),
    ...patch,
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolvePromise) =>
          window.setTimeout(resolvePromise, 0),
        );
      });
    }
  }
  throw lastError;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("flow list hidden actions", () => {
  it("keeps server-backed row actions disabled while browser-private organization remains available", () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onDuplicate = vi.fn();
    const onArchive = vi.fn();
    const { root } = render(
      card({
        canWrite: false,
        writeDisabledReason: "Flows are read-only for this session.",
        onRename,
        onDuplicate,
        onArchive,
      }),
    );
    try {
      for (const label of ["Rename flow", "Duplicate flow", "Archive flow"]) {
        const button = buttonByLabel(label);
        expect(button.disabled).toBe(true);
        expect(button.title).toContain("read-only");
        act(() => button.click());
      }
      expect(buttonByLabel("Edit tags").disabled).toBe(false);
      expect(buttonByLabel("Pin flow").disabled).toBe(false);
      expect(onRename).not.toHaveBeenCalled();
      expect(onDuplicate).not.toHaveBeenCalled();
      expect(onArchive).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps tag edits browser-private, normalized, no-op safe, and single-submit", async () => {
    const onSetTags = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { root } = render(card({ onSetTags }));
    try {
      await act(async () => buttonByLabel("Edit tags").click());
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "browser-private labels",
      );
      expect(buttonByText("Save tags").disabled).toBe(true);

      await act(async () => buttonByText("Cancel").click());
      expect(onSetTags).not.toHaveBeenCalled();

      await act(async () => buttonByLabel("Edit tags").click());
      const input = document.querySelector<HTMLInputElement>(
        'input[id="tags-flow_1"]',
      );
      if (!input) throw new Error("Tag input not found");
      await act(async () => {
        changeInput(
          input,
          " Existing, High Value, HIGH VALUE, Promo, a, b, c, d, e, f, g, h, i, j ",
        );
      });
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(onSetTags).toHaveBeenCalledTimes(1);
      expect(onSetTags).toHaveBeenCalledWith("flow_1", [
        "existing",
        "high value",
        "promo",
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
        "h",
        "i",
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("awaits mounted rename PATCH ownership, blocks duplicate submit, and keeps failures actionable", async () => {
    let settleRename: (() => void) | undefined;
    const onRename = vi
      .fn<Parameters<typeof FlowListCard>[0]["onRename"]>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolvePromise) => {
            settleRename = resolvePromise;
          }),
      )
      .mockRejectedValueOnce(new Error("Rename request failed"))
      .mockResolvedValueOnce(undefined);
    const { root } = render(card({ onRename }));
    try {
      await act(async () => buttonByLabel("Rename flow").click());
      const input = document.querySelector<HTMLInputElement>(
        'input[id="rename-flow_1"]',
      );
      if (!input) throw new Error("Rename input not found");
      await act(async () => changeInput(input, "  Renamed journey  "));

      const rename = buttonByText("Rename");
      await act(async () => {
        rename.click();
        rename.click();
      });
      expect(onRename).toHaveBeenCalledTimes(1);
      expect(onRename).toHaveBeenCalledWith("flow_1", "Renamed journey");
      expect(rename.disabled).toBe(true);
      expect(
        document.querySelector('[role="dialog"]')?.getAttribute("aria-busy"),
      ).toBe("true");

      await act(async () => settleRename?.());
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      });

      await act(async () => buttonByLabel("Rename flow").click());
      const secondInput = document.querySelector<HTMLInputElement>(
        'input[id="rename-flow_1"]',
      );
      if (!secondInput) throw new Error("Second rename input not found");
      await act(async () => changeInput(secondInput, "Failure then retry"));
      await act(async () => buttonByText("Rename").click());
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Rename request failed",
        );
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => buttonByText("Rename").click());
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      });
      expect(onRename).toHaveBeenCalledTimes(3);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("release-held flow activation", () => {
  it("keeps both the active editor boundary and retained dialog visible and transport-free", async () => {
    const onConfirm = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { root } = render(
      createElement(
        "div",
        null,
        createElement(FlowActivationStatus),
        createElement(ActivateFlowDialog, {
          trigger: createElement(
            "button",
            { type: "button" },
            "Activation details",
          ),
          graph: { nodes: [] },
          triggerCatalog: [],
          nodeCatalog: [],
          reEnrollment: "once",
          onConfirm,
        }),
      ),
    );
    try {
      const unavailable = buttonByText("Activation unavailable");
      expect(unavailable.disabled).toBe(true);
      expect(document.body.textContent).toContain(FLOW_ACTIVATION_RELEASE_HOLD);

      await act(async () => buttonByText("Activation details").click());
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "No activation request is available",
      );
      await act(async () => buttonByText("Close").click());
      expect(onConfirm).not.toHaveBeenCalled();

      await expect(flowsApi.activate("flow_1")).rejects.toThrow(
        FLOW_ACTIVATION_RELEASE_HOLD,
      );
      await expect(
        flowsApi.promoteVersion("flow_1", "version_3", true),
      ).rejects.toThrow(FLOW_ACTIVATION_RELEASE_HOLD);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (/\.tsx?$/u.test(path)) files.push(path);
  }
  return files;
}

describe("sequence regeneration reachability", () => {
  it("wires preview and explicit versioned acceptance into the sequence detail route", () => {
    const src = resolve(process.cwd(), "src");
    const appFiles = walk(join(src, "app"));
    const references = appFiles.filter((file) =>
      readFileSync(file, "utf8").includes("RegenerateEmailDialog"),
    );
    expect(references.map((file) => file.slice(src.length + 1)).sort()).toEqual(
      [
        "app/(dashboard)/app/sequences/[id]/page.tsx",
        "app/(dashboard)/app/sequences/[id]/regenerate-email-dialog.tsx",
      ].sort(),
    );

    const sequencePage = readFileSync(
      join(src, "app/(dashboard)/app/sequences/[id]/page.tsx"),
      "utf8",
    );
    expect(sequencePage).toContain('aria-label="Regenerate selected email"');
    expect(sequencePage).toContain("await regenerateEmail(");
    expect(sequencePage).toContain(
      "await updateSequence(snapshot, { requireOnline: true })",
    );
    expect(sequencePage).toContain(
      'regenerationOperationRef.current = "generating"',
    );
    expect(sequencePage).toContain(
      'regenerationOperationRef.current = "accepting"',
    );
    expect(sequencePage).not.toContain("AI regeneration unavailable");
  });
});
