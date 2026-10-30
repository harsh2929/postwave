/**
 * AssetFilterRails — the three ways this library narrows, in the order a person
 * reaches for them.
 *
 * THE SMART FILTERS CARRY REAL TOTALS. `counts` on the list envelope describes
 * the WHOLE tenant asset set and deliberately ignores `filter` / `limit` /
 * `before` (repo.go:182), which is what makes a badge here stable while you
 * page. When the payload carried no counts, the badges are ABSENT rather than
 * zero — a rail claiming "Unused 0" for a workspace that was never measured is
 * the exact lie the em-dash rule exists to prevent.
 *
 * THE FOLDER AND TAG RAILS ONLY EXIST WHEN THEY DO. A workspace with no folders
 * gets no folder rail, rather than a rail with one dead chip in it. That is
 * also why they are separate rows: `folder_id` and `tag` are independent query
 * params that intersect, and merging them into one rail would imply a choice
 * between them.
 *
 * "Uncategorised" is the `folder_id=root` sentinel (folders.go:58), not a
 * folder — it selects the assets whose `folder_id IS NULL`.
 */
import { View } from "react-native";

import { ChipRow } from "@/components/ChipRow";
import { SegmentedControl } from "@/components/SegmentedControl";
import {
  ASSET_FILTERS,
  ASSET_FILTER_HINTS,
  ASSET_FOLDER_ROOT,
  ASSET_SORTS,
  type AssetCounts,
  type AssetFilter,
  type AssetFolder,
  type AssetSort,
  type AssetTagCount,
} from "@/lib/assetLibrary";

/** Sentinel chip value meaning "do not send this param at all". */
export const ASSET_FACET_ANY = "any";

export interface AssetFilterRailsProps {
  filter: AssetFilter;
  onFilterChange: (next: AssetFilter) => void;
  counts: AssetCounts | null;
  folders: readonly AssetFolder[];
  folderId: string | null;
  onFolderChange: (next: string | null) => void;
  tags: readonly AssetTagCount[];
  tag: string | null;
  onTagChange: (next: string | null) => void;
  /**
   * The server's own sort vocabulary (lib/assetLibrary.ASSET_SORTS). A rail
   * rather than a menu: sorting a big library is the same reach-for-a-chip
   * gesture as filtering it, and the active order should be READABLE, not
   * hidden behind an icon.
   */
  sort: AssetSort;
  onSortChange: (next: AssetSort) => void;
}

function facetValue(selection: string | null): string {
  return selection ?? ASSET_FACET_ANY;
}

function facetSelection(next: string): string | null {
  return next === ASSET_FACET_ANY ? null : next;
}

function plural(count: number): string {
  return count === 1 ? "image" : "images";
}

function FolderRail({
  folders,
  folderId,
  onChange,
}: Pick<AssetFilterRailsProps, "folders" | "folderId"> & {
  onChange: (next: string | null) => void;
}) {
  // Built inside the rail, not above it, so a workspace with no folders never
  // pays for an options array it does not render.
  if (folders.length === 0) return null;
  return (
    <ChipRow
      accessibilityLabel="Filter by folder"
      options={[
        {
          value: ASSET_FACET_ANY,
          label: "All folders",
          accessibilityLabel: "All folders, no folder filter",
        },
        {
          value: ASSET_FOLDER_ROOT,
          label: "Uncategorised",
          accessibilityLabel: "Uncategorised, images that are in no folder",
        },
        ...folders.map((folder) => ({
          value: folder.id,
          label: folder.name,
          accessibilityLabel: `${folder.name}, ${folder.assetCount} ${plural(folder.assetCount)}`,
        })),
      ]}
      value={facetValue(folderId)}
      onChange={(next) => onChange(facetSelection(next))}
    />
  );
}

function TagRail({
  tags,
  tag,
  onChange,
}: Pick<AssetFilterRailsProps, "tags" | "tag"> & {
  onChange: (next: string | null) => void;
}) {
  if (tags.length === 0) return null;
  return (
    <ChipRow
      accessibilityLabel="Filter by tag"
      options={[
        {
          value: ASSET_FACET_ANY,
          label: "All tags",
          accessibilityLabel: "All tags, no tag filter",
        },
        ...tags.map((entry) => ({
          value: entry.tag,
          label: entry.tag,
          accessibilityLabel: `${entry.tag}, ${entry.count} ${plural(entry.count)}`,
        })),
      ]}
      value={facetValue(tag)}
      onChange={(next) => onChange(facetSelection(next))}
    />
  );
}

export function AssetFilterRails(props: AssetFilterRailsProps) {
  const filterOptions = ASSET_FILTERS.map((option) => ({
    value: option.value,
    label: option.label,
    // `badge?: number | undefined` — omitted entirely when unmeasured, so a
    // rail never claims "Unused 0" about a workspace nobody counted.
    ...(props.counts ? { badge: props.counts[option.countKey] } : {}),
  }));

  return (
    <View style={{ gap: 8 }}>
      <View style={{ paddingHorizontal: 16 }}>
        <SegmentedControl
          accessibilityLabel="Filter images"
          scrollable
          options={filterOptions}
          value={props.filter}
          onChange={props.onFilterChange}
        />
      </View>
      <ChipRow
        accessibilityLabel="Sort images"
        options={ASSET_SORTS.map((option) => ({
          value: option.value,
          label: option.label,
          accessibilityLabel: `Sort by ${option.label.toLowerCase()}`,
        }))}
        value={props.sort}
        onChange={props.onSortChange}
      />
      <FolderRail
        folders={props.folders}
        folderId={props.folderId}
        onChange={props.onFolderChange}
      />
      <TagRail tags={props.tags} tag={props.tag} onChange={props.onTagChange} />
    </View>
  );
}

/** The sentence under the rail explaining what the active chip selects. */
export function assetFilterHint(filter: AssetFilter): string {
  return ASSET_FILTER_HINTS[filter];
}
