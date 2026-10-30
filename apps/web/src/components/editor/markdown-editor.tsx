// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Heading2,
  Quote,
  Link as LinkIcon,
  Undo2,
  Redo2,
} from "lucide-react";
import TurndownService from "turndown";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { markdownToHtml, normalizeEditorHref } from "./markdown";
import { compactProse } from "@/styles/compact-prose";

interface MarkdownEditorProps {
  initialMarkdown?: string;
  placeholder?: string;
  onChange?: (markdown: string) => void;
  className?: string;
}

/**
 * Tiptap-based markdown editor — Maily-style "writer mode" fallback for
 * folks who'd rather not deal with blocks. Internally Tiptap is HTML-first;
 * we serialize to markdown via Turndown on every transaction.
 */
export function MarkdownEditor({
  initialMarkdown,
  placeholder,
  onChange,
  className,
}: MarkdownEditorProps) {
  const turndown = useMemo(
    () =>
      new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
      }),
    [],
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: "noreferrer" },
      }),
      Placeholder.configure({ placeholder: placeholder ?? "Start writing…" }),
    ],
    content: markdownToHtml(initialMarkdown ?? ""),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: `${compactProse.root} max-w-none min-h-[400px] focus:outline-none px-6 py-5`,
      },
    },
    onUpdate({ editor }) {
      const md = turndown.turndown(editor.getHTML());
      onChangeRef.current?.(md);
    },
  });

  useEffect(() => () => editor?.destroy(), [editor]);

  if (!editor) {
    return (
      <div className={cn("h-[480px] bg-muted/40 animate-pulse", className)} />
    );
  }

  const promptLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    setLinkUrl(previous ?? "https://");
    setLinkOpen(true);
  };

  const applyLink = () => {
    const url = normalizeEditorHref(linkUrl);
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: url })
        .run();
    }
    setLinkOpen(false);
  };

  return (
    <>
      <div className={cn("flex flex-col h-full bg-card", className)}>
        <div className="h-11 flex items-center gap-1 border-b px-2">
          <ToolbarButton
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
            aria-label="Bold"
          >
            <Bold className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            aria-label="Italic"
          >
            <Italic className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("heading", { level: 2 })}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
            aria-label="Heading"
          >
            <Heading2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            aria-label="Bulleted list"
          >
            <List className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            aria-label="Numbered list"
          >
            <ListOrdered className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            aria-label="Quote"
          >
            <Quote className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("link")}
            onClick={promptLink}
            aria-label="Link"
          >
            <LinkIcon className="h-4 w-4" />
          </ToolbarButton>
          <span className="ml-auto inline-flex">
            <ToolbarButton
              onClick={() => editor.chain().focus().undo().run()}
              aria-label="Undo"
            >
              <Undo2 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().redo().run()}
              aria-label="Redo"
            >
              <Redo2 className="h-4 w-4" />
            </ToolbarButton>
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          <EditorContent editor={editor} />
        </div>
      </div>
      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit link</DialogTitle>
            <DialogDescription>
              Enter the destination URL, or leave it blank to remove the link
              from the selected text.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="editor-link-url">URL</Label>
            <Input
              id="editor-link-url"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyLink();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLinkOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={applyLink}>
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ToolbarButton({
  active,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        active && "bg-accent text-accent-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
