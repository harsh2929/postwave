import type { Tag, TagGroup, TagUsage } from "../../lib/api-client";
import {
  isTag,
  isTagGroup,
  isTagUsage,
} from "../../components/tags/tagRemoteValidation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTagCollection(
  payload: unknown,
  envelopeKeys: readonly string[],
): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  const candidates = envelopeKeys
    .map((key) => payload[key])
    .filter((candidate): candidate is unknown[] => Array.isArray(candidate));
  return candidates.length === 1 ? candidates[0]! : null;
}

export function tagIdentityKey(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

export function validTags(value: unknown[] | null): value is Tag[] {
  return Boolean(
    value &&
    value.length <= 10_000 &&
    value.every(isTag) &&
    new Set(value.map((item) => (item as Tag).id.toLowerCase())).size ===
      value.length &&
    new Set(value.map((item) => tagIdentityKey((item as Tag).name))).size ===
      value.length,
  );
}

export function validTagGroups(value: unknown[] | null): value is TagGroup[] {
  return Boolean(
    value &&
    value.length <= 2_000 &&
    value.every(isTagGroup) &&
    new Set(value.map((item) => (item as TagGroup).id.toLowerCase())).size ===
      value.length &&
    new Set(value.map((item) => tagIdentityKey((item as TagGroup).name)))
      .size === value.length,
  );
}

export function validTagUsage(value: unknown[] | null): value is TagUsage[] {
  return Boolean(
    value &&
    value.length <= 10_000 &&
    value.every(isTagUsage) &&
    new Set(value.map((item) => tagIdentityKey((item as TagUsage).tag)))
      .size === value.length,
  );
}

export function tagUsageMap(items: TagUsage[]): Record<string, TagUsage> {
  const map: Record<string, TagUsage> = {};
  for (const usage of items) map[tagIdentityKey(usage.tag)] = usage;
  return map;
}

export function tagUsageForName(
  map: Record<string, TagUsage>,
  name: string,
): TagUsage | undefined {
  return map[tagIdentityKey(name)];
}
