import type { DiscoveryReport, SourcePlatform } from "./types";

export function isMailchimpSource(source: SourcePlatform): boolean {
  return source === "mailchimp";
}

export function selectedAudienceSet(
  discovery: DiscoveryReport | null,
  selectedAudienceIds: string[],
): Set<string> {
  const audiences = discovery?.audiences ?? [];
  if (audiences.length === 0) return new Set(selectedAudienceIds);
  const known = new Set(audiences.map((audience) => audience.id));
  return new Set(selectedAudienceIds.filter((id) => known.has(id)));
}

export function selectedMailchimpAudienceIds(
  discovery: DiscoveryReport | null,
  selectedAudienceIds: string[],
): string[] | undefined {
  const audiences = discovery?.audiences ?? [];
  if (audiences.length === 0) return [];
  const selected = selectedAudienceSet(discovery, selectedAudienceIds);
  if (selected.size === 0) return [];
  return Array.from(selected).sort();
}

export function initialSelectedAudienceIds(
  source: SourcePlatform,
  discovery: DiscoveryReport,
  selectedAudienceIds: string[],
): string[] {
  if (!isMailchimpSource(source)) {
    return selectedAudienceIds;
  }
  if (selectedAudienceIds.length > 0) {
    return (
      selectedMailchimpAudienceIds(discovery, selectedAudienceIds) ??
      selectedAudienceIds
    );
  }
  return [];
}
