import type { Tag, TagUsage } from "../../lib/api-client";
import { api } from "../../lib/api-client";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import {
  GROUP_FILTER_ALL,
  GROUP_FILTER_UNGROUPED,
} from "../../components/tags/TagGroupSidebar";
import type { DesktopSortDirection } from "../../lib/desktop-router";
import type { TagSortField } from "./tagRouteState";
import { tagIdentityKey, tagUsageForName } from "./tagCatalogContracts";
import {
  DEFAULT_TAG_COLOR,
  TAG_PALETTE,
} from "../../components/tags/tagColorPresentation";
import {
  limitRunes,
  runeLength,
} from "../../components/tags/tagWriteConstraints";

export { DEFAULT_TAG_COLOR, TAG_PALETTE };
export { limitRunes, runeLength };

export const TAG_PAGE_SIZE = 25;
export const TAG_COLUMNS = "28px 1.6fr 100px 140px 140px";

export const TAG_GROUPS_UNAVAILABLE_REASON =
  "Tag groups stay unavailable until this workspace's group endpoint is successfully verified.";
export const TAG_MERGE_UNAVAILABLE_REASON =
  "Merge is paused until the server can plan and commit every membership projection atomically with an idempotent receipt.";
export const TAG_DELETE_UNAVAILABLE_REASON =
  "Permanent deletion is paused until the server can provide an exact impact plan and recovery-safe receipt.";

export interface TagDraft {
  name: string;
  color: string;
  description: string;
  groupId: string;
}

export const EMPTY_TAG_DRAFT: TagDraft = {
  name: "",
  color: DEFAULT_TAG_COLOR,
  description: "",
  groupId: "",
};

export type TagDisplayRow =
  | { kind: "tag"; name: string; tag: Tag; usage?: TagUsage }
  | { kind: "orphan"; name: string; usage: TagUsage };

interface BulkDeleteFailure {
  id: string;
  detail: string;
}

export function tagToDraft(tag: Tag): TagDraft {
  return {
    name: tag.name ?? "",
    color: tag.color ?? DEFAULT_TAG_COLOR,
    description: tag.description ?? "",
    groupId: tag.group_id ?? "",
  };
}

export function filterTags(
  rows: Tag[] | null,
  query: string,
  colorFilter: string,
  groupFilter: string,
): Tag[] {
  if (!rows) return [];
  const normalizedQuery = tagIdentityKey(query);
  return rows.filter((tag) => {
    if (
      colorFilter !== "all" &&
      (tag.color ?? DEFAULT_TAG_COLOR).toLowerCase() !== colorFilter
    ) {
      return false;
    }
    if (groupFilter === GROUP_FILTER_UNGROUPED) {
      if (tag.group_id) return false;
    } else if (
      groupFilter !== GROUP_FILTER_ALL &&
      tag.group_id !== groupFilter
    ) {
      return false;
    }
    return (
      !normalizedQuery ||
      tagIdentityKey(tag.name ?? "").includes(normalizedQuery) ||
      (tag.description ?? "")
        .normalize("NFKC")
        .toLowerCase()
        .includes(normalizedQuery)
    );
  });
}

export function buildTagDisplayList(
  filtered: Tag[],
  usageByName: Record<string, TagUsage>,
  query: string,
  colorFilter: string,
  groupFilter: string,
): TagDisplayRow[] {
  const registered: TagDisplayRow[] = filtered.map((tag) => ({
    kind: "tag",
    name: tag.name,
    tag,
    usage: tagUsageForName(usageByName, tag.name),
  }));
  const registeredNames = new Set(
    filtered.map((tag) => tagIdentityKey(tag.name)),
  );
  const normalizedQuery = tagIdentityKey(query);
  const orphans: TagDisplayRow[] = Object.values(usageByName)
    .filter(
      (usage) =>
        !usage.registered && !registeredNames.has(tagIdentityKey(usage.tag)),
    )
    .filter((usage) => {
      if (groupFilter !== GROUP_FILTER_ALL || colorFilter !== "all") {
        return false;
      }
      return (
        !normalizedQuery || tagIdentityKey(usage.tag).includes(normalizedQuery)
      );
    })
    .sort(
      (left, right) =>
        right.subscribers - left.subscribers ||
        left.tag.localeCompare(right.tag),
    )
    .map((usage) => ({ kind: "orphan", name: usage.tag, usage }));
  return [...registered, ...orphans];
}

export function countOrphanTags(
  rows: Tag[] | null,
  usageByName: Record<string, TagUsage>,
): number {
  const registeredNames = new Set(
    (rows ?? []).map((tag) => tagIdentityKey(tag.name)),
  );
  return Object.values(usageByName).filter(
    (usage) =>
      !usage.registered && !registeredNames.has(tagIdentityKey(usage.tag)),
  ).length;
}

export function sortTagDisplayRows(
  rows: TagDisplayRow[],
  field: TagSortField,
  direction: DesktopSortDirection,
): TagDisplayRow[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let comparison = 0;
    if (field === "subscribers") {
      comparison =
        (left.usage?.subscribers ?? -1) - (right.usage?.subscribers ?? -1);
    } else if (field === "created") {
      const leftCreated =
        left.kind === "tag" ? (left.tag.created_at ?? "") : "";
      const rightCreated =
        right.kind === "tag" ? (right.tag.created_at ?? "") : "";
      comparison = leftCreated.localeCompare(rightCreated);
    } else {
      comparison = left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    }
    if (comparison === 0) {
      comparison = left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    }
    return comparison * multiplier;
  });
}

export async function deleteTagsForBulk(
  ids: string[],
  tags: Tag[],
): Promise<{ ok: number; failures: BulkDeleteFailure[] }> {
  let ok = 0;
  const failures: BulkDeleteFailure[] = [];
  for (const id of ids) {
    const tag = tags.find((item) => item.id === id);
    try {
      const result = await api.deleteTag(id);
      if (result.error) {
        failures.push({
          id,
          detail: `${tag?.name ?? id}: ${result.error.message}`,
        });
      } else {
        ok += 1;
      }
    } catch (error) {
      failures.push({
        id,
        detail: `${tag?.name ?? id}: ${lifecycleOperationError(error, "request failed")}`,
      });
    }
  }
  return { ok, failures };
}
