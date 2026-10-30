// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

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
import {
  createSavedBlock,
  listSavedBlocks,
  type SavedBlock,
} from "@/lib/content-library-api";
import {
  savedBlockSource,
  type TemplateSnippetFormat,
} from "@/lib/template-saved-blocks";

export function TemplateSavedBlockPicker({
  tenantId,
  format,
  selectedSource,
  open,
  onOpenChange,
  onInsert,
}: {
  tenantId: string;
  format: TemplateSnippetFormat;
  selectedSource: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (source: string, block: SavedBlock) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SavedBlock[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void listSavedBlocks({
        tenantId,
        q: query,
        limit: 100,
        signal: controller.signal,
      })
        .then((page) => {
          if (controller.signal.aborted) return;
          setItems(page.items);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : "Could not load saved blocks.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, tenantId, query, refresh]);

  const selectedBytes = new TextEncoder().encode(selectedSource).byteLength;
  const isMjmlFragment = format !== "mjml" || !/<\/?(?:mjml|mj-body)\b/i.test(selectedSource);
  const canSave =
    Boolean(selectedSource.trim()) &&
    isMjmlFragment &&
    selectedBytes <= 64 * 1024 &&
    Boolean(name.trim()) &&
    !saving;

  const saveSelection = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await createSavedBlock({
        tenantId,
        name: name.trim(),
        kind: "snippet",
        bodyHtml: format === "html" ? selectedSource : "",
        bodyJson: {
          moosewave_template_fragment_format: format,
          source: selectedSource,
        },
        idempotencyKey: `template-snippet-${crypto.randomUUID()}`,
      });
      setName("");
      setRefresh((value) => value + 1);
      toast.success("Reusable block saved to this workspace");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save block.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Workspace blocks</DialogTitle>
          <DialogDescription>
            Insert a version-pinned snippet, or save selected code for reuse.
            Moosewave will show updates for linked snippets; applying an update always requires your review.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            aria-label="Search workspace blocks"
            placeholder="Search saved blocks"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="max-h-56 space-y-1 overflow-auto rounded-lg border p-2" role="list" aria-label="Saved blocks">
            {loading ? <p className="p-2 text-sm text-muted-foreground">Loading blocks…</p> : null}
            {!loading && items.length === 0 ? <p className="p-2 text-sm text-muted-foreground">No saved blocks found.</p> : null}
            {items.map((block) => {
              const source = savedBlockSource(block, format);
              return (
                <div key={block.id} role="listitem" className="flex items-center justify-between gap-3 rounded-md p-2 hover:bg-muted/50">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{block.name}</p>
                    <p className="text-xs text-muted-foreground">{block.kind} · version {block.version}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!source}
                    title={source ? "Insert a copy at the cursor" : `No ${format.toUpperCase()} source in this block`}
                    onClick={() => {
                      if (!source) return;
                      onInsert(source, block);
                      onOpenChange(false);
                    }}
                  >
                    Insert
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="space-y-2 border-t pt-4">
            <Label htmlFor="template-snippet-name">Save selected {format.toUpperCase()} as a block</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="template-snippet-name"
                className="min-w-48 flex-1"
                maxLength={120}
                placeholder="e.g. Weekly digest footer"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="button" disabled={!canSave} loading={saving} onClick={() => void saveSelection()}>
                Save selection
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {selectedSource.trim()
                ? !isMjmlFragment
                  ? "Select only inner MJML sections or elements, not a full <mjml> or <mj-body> document."
                  : `${selectedBytes.toLocaleString()} bytes selected. Only ${format.toUpperCase()} blocks can be inserted in this source mode.`
                : "Select a source fragment in the editor before opening this library to save it."}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
