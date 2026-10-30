// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";

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
import { listAssets, publicAssetURL, type Asset } from "@/lib/assets-api";

export function TemplateAssetPicker({
  tenantId,
  open,
  onOpenChange,
  onInsert,
}: {
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (url: string, alt: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    pageAbortRef.current?.abort();
    setLoadingMore(false);
    setSelected(null);
    setItems([]);
    setNextCursor(null);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void listAssets({
        tenantId,
        q: query,
        limit: 50,
        signal: controller.signal,
      })
        .then((listing) => {
          if (controller.signal.aborted) return;
          setItems(listing.items);
          setNextCursor(listing.nextCursor);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            setError(
              cause instanceof Error
                ? cause.message
                : "Assets could not be loaded.",
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
      pageAbortRef.current?.abort();
    };
  }, [open, query, tenantId]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const controller = new AbortController();
    pageAbortRef.current = controller;
    setLoadingMore(true);
    try {
      const listing = await listAssets({
        tenantId,
        q: query,
        before: nextCursor,
        limit: 50,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setItems((current) => {
        const seen = new Set(current.map((asset) => asset.id));
        return [
          ...current,
          ...listing.items.filter((asset) => !seen.has(asset.id)),
        ];
      });
      setNextCursor(listing.nextCursor);
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "More images could not be loaded.",
        );
    } finally {
      if (pageAbortRef.current === controller) pageAbortRef.current = null;
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };

  const url = selected ? publicAssetURL(selected) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose an image</DialogTitle>
          <DialogDescription>
            Use a hosted image from your workspace library. Add meaningful alt
            text before inserting it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            aria-label="Search images"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your asset library"
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div
            className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2"
            role="list"
            aria-label="Workspace images"
          >
            {loading ? (
              <p className="p-3 text-sm text-muted-foreground">
                Loading images…
              </p>
            ) : null}
            {!loading && items.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                No images found. Upload one in Assets, then return here.
              </p>
            ) : null}
            {items.map((asset) => {
              const usable = publicAssetURL(asset) !== null;
              return (
                <div key={asset.id} role="listitem">
                  <button
                    type="button"
                    aria-pressed={selected?.id === asset.id}
                    disabled={!usable}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                    onClick={() => {
                      setSelected(asset);
                      setAlt(asset.altText);
                    }}
                  >
                    <span className="min-w-0 truncate">{asset.filename}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {usable
                        ? `${asset.width} × ${asset.height}`
                        : "Private URL"}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          {nextCursor ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading more…" : "Load more images"}
            </Button>
          ) : null}
          {selected ? (
            <div className="space-y-1.5">
              <Label htmlFor="template-asset-alt">Image alt text</Label>
              <Input
                id="template-asset-alt"
                value={alt}
                maxLength={500}
                onChange={(event) => setAlt(event.target.value)}
                placeholder="Describe what this image conveys"
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!url || !alt.trim()}
            onClick={() => {
              if (!url || !alt.trim()) return;
              onInsert(url, alt.trim());
              onOpenChange(false);
            }}
          >
            Insert image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
