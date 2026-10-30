// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

// The GrapesJS stylesheet belongs to this component, not to a route layout.
// A layout-level import becomes an eager <link> on every visit to that route
// (blocking first paint for users who never open Blocks) and is missing
// entirely on the other routes that mount this editor. This module is only
// ever reached through `dynamic(() => import("./block-editor"))`, so webpack
// emits the CSS as an async chunk fetched exactly when the editor mounts.
import "grapesjs/dist/css/grapes.min.css";

import { EditorToolbar } from "./editor-toolbar";
import {
  PreviewPane,
  type PreviewMode,
  type PreviewTheme,
} from "./preview-pane";
import { compileMjmlSource } from "./compile-mjml";
import {
  BRANDED_BLOCKS,
  initialBlockMjml,
  type WorkspaceMJMLBlock,
} from "./moosewave-email-blocks";

// GrapesJS types — imported as `type` only so the heavy bundle is dynamic.
type GrapesEditor = {
  destroy: () => void;
  getHtml: () => string;
  getCss: () => string;
  on: (evt: string, cb: () => void) => void;
  UndoManager: { undo: () => void; redo: () => void };
  setComponents: (s: string) => void;
  Commands: { run: (name: string) => void };
  // grapesjs-mjml exposes runMjml via custom command; we use built-in compile.
  runCommand?: (name: string) => unknown;
};

interface BlockEditorProps {
  /** Initial MJML to load. */
  initialMjml?: string;
  /** Called debounced after each change with the latest MJML and compiled HTML. */
  onChange?: (mjml: string, html: string) => void;
  /** Fires before the debounced compiler so rapid surface switches cannot drop edits. */
  onSourceChange?: (mjml: string) => void;
  /** Called when the user explicitly saves. */
  onSave?: (mjml: string, html: string) => void | Promise<void>;
  /** Optional saving indicator from caller. */
  saving?: boolean;
  /** Tenant-owned snippets are copied into the canvas, never live-synced. */
  workspaceBlocks?: WorkspaceMJMLBlock[];
}

const EMPTY_WORKSPACE_BLOCKS: WorkspaceMJMLBlock[] = [];

function blockLabel(name: string): string {
  return name
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const CURATED_BLOCK_IDS = [
  "mj-text",
  "mj-button",
  "mj-image",
  "mj-divider",
  "mj-spacer",
  "mj-social",
  "mj-2-columns",
  "mj-3-columns",
  "mj-section",
  ...BRANDED_BLOCKS.map((block) => block.id),
];

export function BlockEditor({
  initialMjml,
  onChange,
  onSourceChange,
  onSave,
  saving,
  workspaceBlocks = EMPTY_WORKSPACE_BLOCKS,
}: BlockEditorProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<GrapesEditor | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compileAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const userMutationRef = useRef(false);
  const initialMjmlRef = useRef(initialBlockMjml(initialMjml));
  const onChangeRef = useRef(onChange);
  const onSourceChangeRef = useRef(onSourceChange);
  const compileRef = useRef<() => Promise<void>>(async () => undefined);
  const saveInFlightRef = useRef(false);
  const workspaceBlocksRef = useRef(workspaceBlocks);
  const registeredWorkspaceBlocksRef = useRef(new Map<string, string>());
  workspaceBlocksRef.current = workspaceBlocks;
  onChangeRef.current = onChange;
  onSourceChangeRef.current = onSourceChange;

  const [previewMode, setPreviewMode] = useState<PreviewMode>("desktop");
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>("light");
  const [compiledHtml, setCompiledHtml] = useState<string>("");
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileWarnings, setCompileWarnings] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  // Mount GrapesJS dynamically (the package touches `document` at import time).
  useEffect(() => {
    let cancelled = false;
    const registeredBlocks = registeredWorkspaceBlocksRef.current;
    mountedRef.current = true;
    const node = mountRef.current;
    if (!node) return;

    void (async () => {
      const [{ default: grapesjs }, { default: grapesjsMjml }] =
        await Promise.all([import("grapesjs"), import("grapesjs-mjml")]);
      if (cancelled) return;

      const editor = grapesjs.init({
        container: node,
        height: "100%",
        width: "100%",
        storageManager: false,
        // The default CDN stylesheet is refused by this app's CSP. Serve the
        // same pinned icon font locally so the editor controls remain visible.
        cssIcons: "/vendor/font-awesome-4.7.0/css/font-awesome.min.css",
        plugins: [grapesjsMjml as unknown as (e: unknown) => void],
        components: initialMjmlRef.current,
      }) as unknown as GrapesEditor;

      editorRef.current = editor;

      // Curate the block panel: hide blocks not in our short list.
      const ed = editor as unknown as {
        BlockManager: {
          getAll: () => {
            each: (
              cb: (b: {
                get: (k: string) => string;
                set: (k: string, v: unknown) => void;
              }) => void,
            ) => void;
          };
          add: (
            id: string,
            options: { label: string; category: string; content: string },
          ) => void;
          remove: (id: string) => void;
        };
      };
      BRANDED_BLOCKS.forEach((block) =>
        ed.BlockManager.add(block.id, {
          label: block.label,
          category: "Moosewave",
          content: block.content,
        }),
      );
      workspaceBlocksRef.current.forEach((block) => {
        const id = `mw-saved-${block.id}`;
        ed.BlockManager.add(id, {
          label: blockLabel(block.name),
          category: "Workspace",
          content: block.source,
        });
        registeredBlocks.set(id, `${block.name}\u0000${block.source}`);
      });
      ed.BlockManager.getAll().each((b) => {
        const id = b.get("id");
        if (!CURATED_BLOCK_IDS.includes(id) && !id.startsWith("mw-saved-"))
          b.set("hidden", true);
      });

      let sourceFlushScheduled = false;
      const handleChange = () => {
        userMutationRef.current = true;
        if (!sourceFlushScheduled) {
          sourceFlushScheduled = true;
          queueMicrotask(() => {
            sourceFlushScheduled = false;
            if (!cancelled) onSourceChangeRef.current?.(editor.getHtml());
          });
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => void compileRef.current(), 350);
      };

      editor.on("update", handleChange);
      editor.on("component:add", handleChange);
      editor.on("component:update", handleChange);
      editor.on("component:remove", handleChange);

      setReady(true);
      void compileRef.current();
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      compileAbortRef.current?.abort();
      compileAbortRef.current = null;
      editorRef.current?.destroy();
      editorRef.current = null;
      registeredBlocks.clear();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const manager = (
      editor as unknown as {
        BlockManager: {
          add: (
            id: string,
            options: { label: string; category: string; content: string },
          ) => void;
          remove: (id: string) => void;
        };
      }
    ).BlockManager;
    const incoming = new Set(
      workspaceBlocks.map((block) => `mw-saved-${block.id}`),
    );
    for (const id of registeredWorkspaceBlocksRef.current.keys()) {
      if (!incoming.has(id)) {
        manager.remove(id);
        registeredWorkspaceBlocksRef.current.delete(id);
      }
    }
    workspaceBlocks.forEach((block) => {
      const id = `mw-saved-${block.id}`;
      const identity = `${block.name}\u0000${block.source}`;
      if (registeredWorkspaceBlocksRef.current.get(id) === identity) return;
      manager.add(id, {
        label: blockLabel(block.name),
        category: "Workspace",
        content: block.source,
      });
      registeredWorkspaceBlocksRef.current.set(id, identity);
    });
  }, [workspaceBlocks, ready]);

  async function getMjmlSource(): Promise<string> {
    const editor = editorRef.current;
    if (!editor) return "";
    // grapesjs-mjml stores the MJML markup directly as components — `getHtml`
    // returns the MJML string (the plugin overrides this).
    return editor.getHtml();
  }

  async function compileSource(
    mjml: string,
    notifyChange: boolean,
    strict = false,
  ): Promise<string | null> {
    compileAbortRef.current?.abort();
    const ctrl = new AbortController();
    compileAbortRef.current = ctrl;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 15_000);
    try {
      const data = await compileMjmlSource(mjml, ctrl.signal);
      if (!mountedRef.current || compileAbortRef.current !== ctrl) return null;
      setCompileError(null);
      setCompileWarnings(
        data.errors.map(
          (warning) =>
            warning.formattedMessage ||
            `${warning.line ? `Line ${warning.line}: ` : ""}${warning.message || "MJML validation warning"}`,
        ),
      );
      setCompiledHtml(data.html);
      // Client renders consume this callback. MJML with validation warnings
      // can still be inspected in the local canvas, but must not be presented
      // as a current, sendable HTML render in the Clients tab.
      if (notifyChange && data.errors.length === 0) {
        onChangeRef.current?.(mjml, data.html);
      }
      return strict && data.errors.length > 0 ? null : data.html;
    } catch (err) {
      if (!mountedRef.current || compileAbortRef.current !== ctrl) return null;
      if (
        err instanceof DOMException &&
        err.name === "AbortError" &&
        !timedOut
      ) {
        return null;
      }
      if (timedOut) {
        setCompileError("MJML compile timed out. Please try again.");
        return null;
      }
      setCompileError(err instanceof Error ? err.message : "Compile failed");
      setCompileWarnings([]);
      return null;
    } finally {
      clearTimeout(timer);
      if (compileAbortRef.current === ctrl) {
        compileAbortRef.current = null;
      }
    }
  }

  async function compile(): Promise<void> {
    const mjml = await getMjmlSource();
    // New designs begin with real editable content. Surface that first canvas
    // snapshot to the owning form so preflight and crash recovery inspect the
    // same source Save would submit, even before the first drag operation.
    const notifyChange = userMutationRef.current || !initialMjml?.trim();
    const html = await compileSource(mjml, notifyChange);
    if (html !== null && notifyChange) userMutationRef.current = false;
  }
  compileRef.current = compile;

  return (
    <div className="flex flex-col h-full min-h-[640px]">
      <EditorToolbar
        saving={saving}
        previewMode={previewMode}
        onPreviewModeChange={setPreviewMode}
        previewTheme={previewTheme}
        onPreviewThemeChange={setPreviewTheme}
        onUndo={() => editorRef.current?.UndoManager.undo()}
        onRedo={() => editorRef.current?.UndoManager.redo()}
        onSave={async () => {
          if (saveInFlightRef.current) return;
          saveInFlightRef.current = true;
          try {
            const mjml = await getMjmlSource();
            // Compile the exact editor snapshot being saved. This closes the
            // debounce race where Save previously paired fresh MJML with stale
            // HTML (or saved before any compile completed).
            const html = await compileSource(mjml, false, true);
            if (html !== null) await onSave?.(mjml, html);
          } finally {
            saveInFlightRef.current = false;
          }
        }}
      />
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 min-h-0">
        <div ref={mountRef} className="border-r min-h-0 overflow-hidden" />
        <div className="min-h-0 overflow-hidden flex flex-col">
          {compileError && (
            <div className="px-4 py-2 text-xs bg-destructive/10 text-destructive-emphasis border-b">
              MJML: {compileError}
            </div>
          )}
          {!compileError && compileWarnings.length > 0 ? (
            <div className="border-b border-warning/40 bg-warning-subtle px-4 py-2 text-xs text-warning-emphasis">
              <p className="font-medium">MJML validation warnings</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {compileWarnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!ready && (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Loading editor…
            </div>
          )}
          {ready && (
            <PreviewPane
              html={compiledHtml}
              mode={previewMode}
              theme={previewTheme}
            />
          )}
        </div>
      </div>
    </div>
  );
}
