// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * AssetPickerDialog — "pick one image from the library" over
 * GET /api/v1/assets (desktop reference: components/library/AssetPicker.tsx).
 *
 * Lean by design: a search box, a flat single-select grid, Cancel / Use image.
 * Consumers that need to manage assets go to /app/assets; this only returns
 * the chosen Asset record. Loaded on demand (next/dynamic) by its callers so
 * it costs nothing on routes where nobody opens it.
 */
import { useId, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ImageIcon, Search } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { apiErrorMessage } from "@/lib/api";
import { listAssets, publicAssetURL, type Asset } from "@/lib/assets-api";
import { STALE } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

export const ASSET_PICKER_PAGE_SIZE = 60;

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function AssetPickerDialog({
  open,
  tenantId,
  title = "Choose an image",
  onOpenChange,
  onPick,
}: {
  open: boolean;
  tenantId: string;
  title?: string;
  onOpenChange: (open: boolean) => void;
  onPick: (asset: Asset) => void;
}) {
  const searchId = useId();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const assets = useQuery({
    queryKey: ["asset-picker", tenantId, query],
    queryFn: ({ signal }) =>
      listAssets({
        tenantId,
        limit: ASSET_PICKER_PAGE_SIZE,
        q: query || undefined,
        sort: "newest",
        signal,
      }),
    enabled: open && tenantId.length > 0,
    staleTime: STALE.list,
    retry: false,
  });

  const items = Array.isArray(assets.data?.items) ? assets.data.items : [];
  const selected = items.find((asset) => asset.id === selectedId) ?? null;

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(draft.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelectedId(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl" aria-busy={assets.isFetching}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Pick an image from the workspace library. Uploads happen on the
            Assets page.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={onSearch}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={searchId}>Search images</Label>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id={searchId}
                type="search"
                className="pl-9"
                value={draft}
                maxLength={200}
                autoComplete="off"
                placeholder="File name or alt text"
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
          </div>
          <Button
            type="submit"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            loading={assets.isFetching}
          >
            Search
          </Button>
        </form>

        {assets.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading library images…
          </p>
        ) : assets.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Library images could not be loaded</AlertTitle>
            <AlertDescription>
              {apiErrorMessage(
                assets.error,
                "The asset list request failed; no empty library is being inferred.",
              )}
            </AlertDescription>
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={assets.isFetching}
                onClick={() => void assets.refetch()}
              >
                Try again
              </Button>
            </div>
          </Alert>
        ) : items.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {query
              ? `No images match “${query}”.`
              : "The library has no images yet."}
          </p>
        ) : (
          <div
            role="listbox"
            aria-label="Library images"
            tabIndex={0}
            className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto rounded-md border p-2 sm:grid-cols-3"
          >
            {items.map((asset) => {
              const isSelected = asset.id === selectedId;
              const src = publicAssetURL(asset);
              return (
                <button
                  key={asset.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`${asset.filename}, ${asset.width} by ${asset.height}, ${formatBytes(asset.bytes)}`}
                  className={cn(
                    "flex min-h-11 flex-col gap-1 rounded-md border p-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isSelected
                      ? "border-primary bg-primary/10"
                      : "hover:bg-muted/40",
                  )}
                  onClick={() => setSelectedId(asset.id)}
                  onDoubleClick={() => {
                    onPick(asset);
                    setSelectedId(null);
                    onOpenChange(false);
                  }}
                >
                  <span className="flex h-20 items-center justify-center overflow-hidden rounded bg-muted/30">
                    {src ? (
                      // Library images are served from the tenant's public
                      // asset origin; publicAssetURL only returns https URLs.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={src}
                        alt=""
                        loading="lazy"
                        className="max-h-20 max-w-full object-contain"
                      />
                    ) : (
                      <ImageIcon
                        aria-hidden
                        className="size-6 text-muted-foreground"
                      />
                    )}
                  </span>
                  <span className="truncate font-medium">{asset.filename}</span>
                  <span className="text-muted-foreground">
                    {asset.width}×{asset.height} · {formatBytes(asset.bytes)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selected === null}
            onClick={() => {
              if (!selected) return;
              onPick(selected);
              setSelectedId(null);
              onOpenChange(false);
            }}
          >
            Use image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
