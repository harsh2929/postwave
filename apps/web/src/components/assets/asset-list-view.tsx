// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import type { Asset } from "@/lib/assets-api";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * List view of the asset library (desktop parity: LibraryToolbar "List"). One
 * row per loaded asset with the facts the grid tile shows, the page's own
 * selection state, and the page's per-asset actions rendered in the last
 * column — the table never fetches or mutates anything itself.
 */
export function AssetListView({
  assets,
  selected,
  selectable,
  onToggle,
  renderActions,
}: {
  assets: readonly Asset[];
  selected: ReadonlySet<string>;
  /** Whether selection checkboxes are offered for this role. */
  selectable: boolean;
  onToggle: (asset: Asset, checked: boolean) => void;
  renderActions?: (asset: Asset) => ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label="Assets table"
      tabIndex={0}
      className="mt-3 overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            {selectable ? (
              <th scope="col" className="w-10 px-3 py-2">
                <span className="sr-only">Select</span>
              </th>
            ) : null}
            <th scope="col" className="px-3 py-2 font-medium">
              File
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Dimensions
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Size
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Live references
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Updated
            </th>
            {renderActions ? (
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {assets.map((asset) => (
            <tr key={asset.id} className="align-middle">
              {selectable ? (
                <td className="px-3 py-2">
                  <Checkbox
                    aria-label={`Select ${asset.filename}`}
                    checked={selected.has(asset.id)}
                    onChange={(event) => onToggle(asset, event.target.checked)}
                  />
                </td>
              ) : null}
              <th scope="row" className="max-w-[18rem] px-3 py-2 text-left">
                <span
                  className="block truncate font-medium"
                  title={asset.filename}
                >
                  {asset.filename}
                </span>
                {asset.altText ? (
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {asset.altText}
                  </span>
                ) : null}
              </th>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                {asset.width} × {asset.height}px
              </td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                {formatBytes(asset.bytes)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                {asset.referencesCount.toLocaleString()}
              </td>
              <td className="whitespace-nowrap px-3 py-2">
                {formatDate(asset.updatedAt)}
              </td>
              {renderActions ? (
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-1">
                    {renderActions(asset)}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
