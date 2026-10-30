/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-only

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EDITOR_MODE_STORAGE_KEY } from "@/components/editor/editor-mode";
import { EditorShell } from "@/components/editor/editor-shell";

const dynamicState = vi.hoisted(() => ({
  nextBoundary: 0,
  mounted: [0, 0, 0],
  props: [null, null, null] as Array<Record<string, unknown> | null>,
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: () => {
      const boundary = dynamicState.nextBoundary++;
      return function DynamicBoundary(
        boundaryProps: Record<string, unknown>,
      ): JSX.Element {
        React.useEffect(() => {
          dynamicState.mounted[boundary] += 1;
          return () => {
            dynamicState.mounted[boundary] -= 1;
          };
        }, []);
        React.useEffect(() => {
          dynamicState.props[boundary] = boundaryProps;
        }, [boundaryProps]);
        return (
          <div data-dynamic-editor-boundary={boundary}>
            {boundary === 2 && typeof boundaryProps.html === "string"
              ? boundaryProps.html
              : null}
          </div>
        );
      };
    },
  };
});

describe("EditorShell persisted-mode loading", () => {
  beforeEach(() => {
    dynamicState.mounted.fill(0);
    dynamicState.props.fill(null);
    window.localStorage.clear();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
  });

  it("mounts only Blocks for a returning Blocks user", async () => {
    window.localStorage.setItem(
      EDITOR_MODE_STORAGE_KEY,
      JSON.stringify({ campaign: "blocks" }),
    );

    await act(async () => {
      root?.render(createElement(EditorShell, { documentId: "campaign" }));
      await Promise.resolve();
    });

    expect(dynamicState.mounted).toEqual([0, 1, 0]);
  });

  it("seeds a Markdown-only draft's Blocks canvas with its existing content", async () => {
    window.localStorage.setItem(
      EDITOR_MODE_STORAGE_KEY,
      JSON.stringify({ manual: "blocks" }),
    );
    const onMjmlChange = vi.fn();
    await act(async () => {
      root?.render(
        createElement(EditorShell, {
          documentId: "manual",
          initialMarkdown: "**Keep my welcome copy**",
          initialMjml: "",
          initialHtml: "",
          onMjmlChange,
        }),
      );
      await Promise.resolve();
    });
    expect(dynamicState.props[1]?.initialMjml).toContain(
      "<mj-text><p><strong>Keep my welcome copy</strong></p></mj-text>",
    );
    expect(onMjmlChange).not.toHaveBeenCalled();
    expect(dynamicState.mounted).toEqual([0, 1, 0]);
  });

  it("seeds Clients from authoritative HTML and resets it on a document switch", async () => {
    window.localStorage.setItem(
      EDITOR_MODE_STORAGE_KEY,
      JSON.stringify({ first: "clients", second: "clients" }),
    );

    await act(async () => {
      root?.render(
        createElement(EditorShell, {
          documentId: "first",
          initialMarkdown: "stale markdown",
          initialHtml: "<main>authoritative first</main>",
        }),
      );
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-dynamic-editor-boundary="2"]')?.textContent,
    ).toBe("<main>authoritative first</main>");

    await act(async () => {
      root?.render(
        createElement(EditorShell, {
          documentId: "second",
          initialMarkdown: "different stale markdown",
          initialHtml: "<main>authoritative second</main>",
        }),
      );
      await Promise.resolve();
    });

    const preview = document.querySelector(
      '[data-dynamic-editor-boundary="2"]',
    );
    expect(preview?.textContent).toBe("<main>authoritative second</main>");
    expect(preview?.textContent).not.toContain("first");
  });

  it.each(["", "  \n "])(
    "renders Markdown in Clients when the stored HTML projection is empty (%j)",
    async (initialHtml) => {
      window.localStorage.setItem(
        EDITOR_MODE_STORAGE_KEY,
        JSON.stringify({ manual: "clients" }),
      );
      await act(async () => {
        root?.render(
          createElement(EditorShell, {
            documentId: "manual",
            initialMarkdown: "**Welcome** to your workspace",
            initialHtml,
          }),
        );
        await Promise.resolve();
      });
      const html = document.querySelector(
        '[data-dynamic-editor-boundary="2"]',
      )?.textContent;
      expect(html).toContain("<strong>Welcome</strong>");
      expect(html).toContain("to your workspace");
      expect(dynamicState.mounted).toEqual([0, 0, 1]);
    },
  );

  it("lets a Blocks mutation supersede the initial Clients HTML", async () => {
    window.localStorage.setItem(
      EDITOR_MODE_STORAGE_KEY,
      JSON.stringify({ campaign: "blocks" }),
    );

    await act(async () => {
      root?.render(
        createElement(EditorShell, {
          documentId: "campaign",
          initialMjml: "<mjml>stored</mjml>",
          initialHtml: "<p>stored HTML</p>",
        }),
      );
      await Promise.resolve();
    });

    const onChange = dynamicState.props[1]?.onChange as
      | ((mjml: string, html: string) => void)
      | undefined;
    expect(onChange).toBeTypeOf("function");
    await act(async () => {
      onChange?.("<mjml>changed</mjml>", "<p>fresh compiled HTML</p>");
    });

    const clientsTab = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Clients",
    );
    expect(clientsTab).toBeTruthy();
    await act(async () => clientsTab?.click());

    expect(
      document.querySelector('[data-dynamic-editor-boundary="2"]')?.textContent,
    ).toBe("<p>fresh compiled HTML</p>");
  });

  it("keeps a Blocks source edit when switching modes before compilation", async () => {
    window.localStorage.setItem(
      EDITOR_MODE_STORAGE_KEY,
      JSON.stringify({ campaign: "blocks" }),
    );
    const onMjmlSourceChange = vi.fn();
    await act(async () => {
      root?.render(
        createElement(EditorShell, {
          documentId: "campaign",
          initialMjml: "<mjml>stored</mjml>",
          onMjmlSourceChange,
        }),
      );
      await Promise.resolve();
    });
    const onSourceChange = dynamicState.props[1]?.onSourceChange as
      | ((mjml: string) => void)
      | undefined;
    await act(async () => onSourceChange?.("<mjml>new draft</mjml>"));
    expect(onMjmlSourceChange).toHaveBeenCalledWith("<mjml>new draft</mjml>");
    const tab = (label: string) =>
      Array.from(document.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === label,
      );
    await act(async () => tab("Clients")?.click());
    await act(async () => tab("Blocks (MJML)")?.click());
    expect(dynamicState.props[1]?.initialMjml).toBe("<mjml>new draft</mjml>");
  });

  it("guards Writer Save against rapid duplicates and exposes a 44px busy control", async () => {
    window.localStorage.setItem(
      EDITOR_MODE_STORAGE_KEY,
      JSON.stringify({ campaign: "writer" }),
    );
    let releaseSave: (() => void) | undefined;
    const onSaveMarkdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );

    await act(async () => {
      root?.render(
        createElement(EditorShell, {
          documentId: "campaign",
          initialMarkdown: "stored",
          onSaveMarkdown,
        }),
      );
      await Promise.resolve();
    });

    const onChange = dynamicState.props[0]?.onChange as
      | ((markdown: string) => void)
      | undefined;
    await act(async () => onChange?.("latest draft"));
    const save = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(save).toBeTruthy();

    await act(async () => {
      save?.click();
      save?.click();
      await Promise.resolve();
    });

    expect(onSaveMarkdown).toHaveBeenCalledTimes(1);
    expect(onSaveMarkdown).toHaveBeenCalledWith("latest draft");
    const busySave = document.querySelector<HTMLButtonElement>(
      'button[data-slot="button"][aria-busy="true"]',
    );
    expect(busySave?.disabled).toBe(true);
    expect(busySave?.className).toContain("min-h-11");

    await act(async () => {
      releaseSave?.();
      await Promise.resolve();
    });
    const settledSave = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(settledSave?.getAttribute("aria-busy")).toBeNull();
    expect(settledSave?.disabled).toBe(false);
  });
});
