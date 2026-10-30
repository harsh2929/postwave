// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { markdownToHtml } from "./markdown";
import {
  EDITOR_MODE_STORAGE_KEY,
  isEditorMode,
  parseStoredEditorModes,
  type EditorMode,
} from "./editor-mode";

function EditorModeLoading({ label }: { label: string }): JSX.Element {
  return (
    <div
      className="flex min-h-[640px] flex-1 items-center justify-center text-sm text-muted-foreground"
      role="status"
    >
      Loading {label}…
    </div>
  );
}

// Each editing surface has a materially different dependency graph. In
// particular, Writer pulls in ProseMirror/Tiptap and Blocks later loads
// GrapesJS. Keep those graphs out of the sequence route's startup shell and
// fetch only the mode the user actually opens.
const MarkdownEditor = dynamic(
  () => import("./markdown-editor").then((mod) => mod.MarkdownEditor),
  {
    ssr: false,
    loading: () => <EditorModeLoading label="writer" />,
  },
);

const BlockEditor = dynamic(
  () => import("./block-editor").then((mod) => mod.BlockEditor),
  {
    ssr: false,
    loading: () => <EditorModeLoading label="block editor" />,
  },
);

const CrossClientPreview = dynamic(
  () => import("./cross-client-preview").then((mod) => mod.CrossClientPreview),
  {
    ssr: false,
    loading: () => <EditorModeLoading label="client preview" />,
  },
);

interface EditorShellProps {
  /** Stable identifier so the chosen mode persists per-document. */
  documentId: string;
  initialMarkdown?: string;
  initialMjml?: string;
  /** Authoritative compiled HTML used before either editor emits a change. */
  initialHtml?: string;
  onMarkdownChange?: (md: string) => void;
  onMjmlChange?: (mjml: string, html: string) => void;
  onMjmlSourceChange?: (mjml: string) => void;
  onSaveMarkdown?: (md: string) => void | Promise<void>;
  onSaveMjml?: (mjml: string, html: string) => void | Promise<void>;
  saving?: boolean;
  /** Limit a route to modes that can faithfully edit its persisted source. */
  allowedModes?: EditorMode[];
  workspaceBlocks?: Array<{ id: string; name: string; source: string }>;
}

const EMPTY_WORKSPACE_BLOCKS: NonNullable<EditorShellProps["workspaceBlocks"]> =
  [];

interface ResolvedEditorMode {
  documentId: string;
  mode: EditorMode;
}

interface DocumentValue {
  documentId: string;
  /** Seed identifies the parent value this local value was derived from. */
  seed: string;
  value: string;
}

interface WriterSaveAttempt {
  documentId: string;
  id: number;
}

const DEFAULT_EDITOR_MODES: EditorMode[] = ["writer", "blocks", "clients"];

function readStoredMode(documentId: string): EditorMode | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EDITOR_MODE_STORAGE_KEY);
    const parsed = parseStoredEditorModes(raw);
    const mode = parsed[documentId] ?? null;
    if (raw && JSON.stringify(parsed) !== raw) {
      window.localStorage.setItem(
        EDITOR_MODE_STORAGE_KEY,
        JSON.stringify(parsed),
      );
    }
    return mode;
  } catch {
    return null;
  }
}

function writeStoredMode(documentId: string, mode: EditorMode) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(EDITOR_MODE_STORAGE_KEY);
    const parsed = parseStoredEditorModes(raw);
    parsed[documentId] = mode;
    window.localStorage.setItem(
      EDITOR_MODE_STORAGE_KEY,
      JSON.stringify(parsed),
    );
  } catch {
    /* noop */
  }
}

export function EditorShell({
  documentId,
  initialMarkdown,
  initialMjml,
  initialHtml,
  onMarkdownChange,
  onMjmlChange,
  onMjmlSourceChange,
  onSaveMarkdown,
  onSaveMjml,
  saving,
  allowedModes = DEFAULT_EDITOR_MODES,
  workspaceBlocks = EMPTY_WORKSPACE_BLOCKS,
}: EditorShellProps) {
  // Do not assume Writer before the browser-backed preference is available.
  // That transient default mounted the Tiptap graph and then mounted Blocks or
  // Clients for returning users. Keying the resolution to documentId also
  // restores the neutral state synchronously when the shell is reused for a
  // different document, before its effect reads that document's preference.
  const [resolvedMode, setResolvedMode] = useState<ResolvedEditorMode | null>(
    null,
  );
  const mode =
    resolvedMode?.documentId === documentId ? resolvedMode.mode : null;
  const markdownSeed = initialMarkdown ?? "";
  // Writer-only drafts have no MJML yet. Seed their Blocks canvas from the
  // existing copy so merely opening that mode cannot replace it with a starter.
  const mjmlSeed = initialMjml?.trim()
    ? initialMjml
    : markdownSeed.trim()
      ? `<mjml><mj-body><mj-section><mj-column><mj-text>${markdownToHtml(markdownSeed)}</mj-text></mj-column></mj-section></mj-body></mjml>`
      : "";
  // Manual sequence drafts can persist Markdown with an empty HTML projection.
  // Treat that empty projection as absent, while retaining non-empty designed HTML.
  const previewSeed = initialHtml?.trim()
    ? initialHtml
    : markdownToHtml(markdownSeed);
  const [markdownDraft, setMarkdownDraft] = useState<DocumentValue>(() => ({
    documentId,
    seed: markdownSeed,
    value: markdownSeed,
  }));
  const [previewHtml, setPreviewHtml] = useState<DocumentValue>(() => ({
    documentId,
    seed: previewSeed,
    value: previewSeed,
  }));
  const [mjmlDraft, setMjmlDraft] = useState<DocumentValue>(() => ({
    documentId,
    seed: mjmlSeed,
    value: mjmlSeed,
  }));
  // A shell can be reused without React unmounting it. Key local values by
  // document as well as by their parent seed so the first render for the next
  // document can never expose or save the previous document's content.
  const draftMarkdown =
    markdownDraft.documentId === documentId &&
    markdownDraft.seed === markdownSeed
      ? markdownDraft.value
      : markdownSeed;
  const latestHtml =
    previewHtml.documentId === documentId && previewHtml.seed === previewSeed
      ? previewHtml.value
      : previewSeed;
  const draftMjml =
    mjmlDraft.documentId === documentId && mjmlDraft.seed === mjmlSeed
      ? mjmlDraft.value
      : mjmlSeed;
  const saveAttemptId = useRef(0);
  const activeWriterSave = useRef<WriterSaveAttempt | null>(null);
  const [pendingWriterSave, setPendingWriterSave] =
    useState<WriterSaveAttempt | null>(null);
  const writerSaving =
    Boolean(saving) || pendingWriterSave?.documentId === documentId;

  useEffect(() => {
    const stored = readStoredMode(documentId);
    setResolvedMode({
      documentId,
      mode:
        stored && allowedModes.includes(stored)
          ? stored
          : (allowedModes[0] ?? "writer"),
    });
  }, [documentId, allowedModes]);

  const onModeChange = (next: string) => {
    if (!isEditorMode(next) || !allowedModes.includes(next)) return;
    setResolvedMode({ documentId, mode: next });
    writeStoredMode(documentId, next);
  };

  const saveWriter = async (): Promise<void> => {
    if (
      saving ||
      !onSaveMarkdown ||
      activeWriterSave.current?.documentId === documentId
    ) {
      return;
    }
    const attempt = { documentId, id: ++saveAttemptId.current };
    activeWriterSave.current = attempt;
    setPendingWriterSave(attempt);
    try {
      await onSaveMarkdown(draftMarkdown);
    } catch {
      // Save error presentation belongs to the owning form/page. The shell
      // still releases its synchronous duplicate-submit lock.
    } finally {
      if (activeWriterSave.current?.id === attempt.id) {
        activeWriterSave.current = null;
      }
      setPendingWriterSave((current) =>
        current?.id === attempt.id ? null : current,
      );
    }
  };

  if (mode === null) {
    return (
      <div className="flex min-h-[640px] flex-1">
        <EditorModeLoading label="editor preferences" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-[640px]">
      <Tabs
        value={mode}
        onValueChange={onModeChange}
        className="flex flex-col h-full"
      >
        {allowedModes.length > 1 ? (
          <div className="border-b px-3 pt-2 bg-card">
            <TabsList aria-label="Editor mode">
              {allowedModes.includes("writer") ? (
                <TabsTrigger value="writer" aria-label="Writer mode (Markdown)">
                  Writer
                </TabsTrigger>
              ) : null}
              {allowedModes.includes("blocks") ? (
                <TabsTrigger
                  value="blocks"
                  aria-label="Blocks mode (MJML drag and drop)"
                >
                  Blocks (MJML)
                </TabsTrigger>
              ) : null}
              {allowedModes.includes("clients") ? (
                <TabsTrigger value="clients" aria-label="Cross-client preview">
                  Clients
                </TabsTrigger>
              ) : null}
            </TabsList>
          </div>
        ) : null}
        <TabsContent value="writer" className="flex-1 mt-0 min-h-0">
          <div className="flex flex-col h-full">
            <MarkdownEditor
              key={`writer-${documentId}`}
              initialMarkdown={initialMarkdown}
              onChange={(md) => {
                setMarkdownDraft({
                  documentId,
                  seed: markdownSeed,
                  value: md,
                });
                setPreviewHtml({
                  documentId,
                  seed: previewSeed,
                  value: markdownToHtml(md),
                });
                onMarkdownChange?.(md);
              }}
              className="flex-1"
            />
            <div className="border-t bg-card p-2 flex justify-end">
              <Button
                type="button"
                onClick={() => void saveWriter()}
                loading={writerSaving}
                disabled={!onSaveMarkdown}
                className="min-h-11"
              >
                {writerSaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="blocks" className="flex-1 mt-0 min-h-0">
          <BlockEditor
            key={`blocks-${documentId}`}
            initialMjml={draftMjml}
            workspaceBlocks={workspaceBlocks}
            onSourceChange={(mjml) => {
              setMjmlDraft({ documentId, seed: mjmlSeed, value: mjml });
              // A compile from the previous source must never be presented as
              // the current draft when the author opens the Clients tab.
              setPreviewHtml({ documentId, seed: previewSeed, value: "" });
              onMjmlSourceChange?.(mjml);
            }}
            onChange={(mjml, html) => {
              setMjmlDraft({ documentId, seed: mjmlSeed, value: mjml });
              setPreviewHtml({
                documentId,
                seed: previewSeed,
                value: html,
              });
              onMjmlChange?.(mjml, html);
            }}
            onSave={onSaveMjml}
            saving={saving}
          />
        </TabsContent>
        <TabsContent value="clients" className="flex-1 mt-0 min-h-0">
          <CrossClientPreview html={latestHtml} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
