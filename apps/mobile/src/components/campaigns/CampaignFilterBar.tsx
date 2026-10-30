/**
 * CampaignFilterBar — search field plus the status chips.
 *
 * The chip counts come from GET /api/v1/campaigns/count, which honours the
 * same name/subject filter the list uses, so a chip states the WORKSPACE
 * number rather than a count of the pages fetched so far.
 *
 * The "Needs attention" bucket exists because failed and cancelled campaigns
 * were previously filed under a chip labelled "Sent" — the app camouflaged a
 * failed send as a success. Its urgency is carried by a glyph in the label,
 * not by colour alone.
 */
import { Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { ChipRow } from "@/components/ChipRow";
import { SearchField } from "@/components/SearchField";
import {
  ALL_FOLDERS,
  type CampaignFolderFilter,
  type FolderOption,
} from "@/lib/campaignFolders";
import { CAMPAIGN_SORTS, type CampaignSort } from "@/lib/campaignSort";
import {
  CAMPAIGN_STATUS_FILTERS,
  type CampaignStatusCounts,
  type CampaignStatusFilter,
} from "@/lib/campaignStatusFilter";
import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import { msg, pluralMsg } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface CampaignFilterBarProps {
  query: string;
  onQueryChange: (next: string) => void;
  resultCount: number | null;
  filter: CampaignStatusFilter;
  onFilterChange: (next: CampaignStatusFilter) => void;
  counts: CampaignStatusCounts;
  sort: CampaignSort;
  onSortChange: (next: CampaignSort) => void;
  /** Stated when the sort only covers the pages loaded so far. */
  sortCaveat: string | null;
  /**
   * True while the list is in agenda mode (the Scheduled bucket), where the
   * order is fixed and chronological. The sort chips are replaced rather than
   * disabled: a row of controls that cannot change anything is worse than no
   * row, and the sentence that takes their place says what the order IS.
   */
  agenda?: boolean;
  /**
   * FOLDERS. A workspace that files 400 campaigns into folders on desktop saw
   * one flat list here. `folder_id` is already on every list row
   * (apps/api/internal/campaigns/repo.go:762) — but GET /api/v1/campaigns
   * has NO folder query param, so this filter narrows the loaded pages only,
   * which is what `folderCaveat` states. The row is hidden entirely when the
   * workspace has no folders, rather than showing a control with one option.
   */
  folder: CampaignFolderFilter;
  onFolderChange: (next: CampaignFolderFilter) => void;
  folderOptions: readonly FolderOption[];
  folderCaveat: string | null;
}

/**
 * The status chip's spoken label, in FOUR whole frames.
 *
 * It used to be one English frame with two clauses appended by ternary
 * (`, ${plural(n, "campaign")}` and `, needs attention`). "Needs attention" is
 * a different sentence rather than a suffix, and the count clause inflects, so
 * a translator has to own all four — which is exactly what concatenation in
 * here prevents.
 */
function chipSpokenLabel(label: string, count: number, urgent: boolean): string {
  if (count > 0) {
    return urgent
      ? pluralMsg("campaigns.filter.a11y.urgentCounted", count, { label })
      : pluralMsg("campaigns.filter.a11y.counted", count, { label });
  }
  return urgent
    ? msg("campaigns.filter.a11y.urgent", { label })
    : msg("campaigns.filter.a11y", { label });
}

export function CampaignFilterBar({
  query,
  onQueryChange,
  resultCount,
  filter,
  onFilterChange,
  counts,
  sort,
  onSortChange,
  sortCaveat,
  agenda = false,
  folder,
  onFolderChange,
  folderOptions,
  folderCaveat,
}: CampaignFilterBarProps) {
  const { t } = useTheme();
  return (
    <View style={{ paddingTop: 4, paddingBottom: 8 }}>
      <View style={{ paddingHorizontal: 16 }}>
        <SearchField
          value={query}
          onChangeText={onQueryChange}
          placeholder={msg("campaigns.search.placeholder")}
          accessibilityLabel={msg("campaigns.search.a11y")}
          {...(resultCount != null
            ? { resultCount, resultNoun: msg("campaigns.search.resultNoun") }
            : {})}
        />
        <View
          style={{
            flexDirection: "row",
            gap: 6,
            marginTop: 10,
            flexWrap: "wrap",
          }}
        >
          {CAMPAIGN_STATUS_FILTERS.map((f) => {
            const n = counts[f.key];
            const urgent = f.tone === "danger" && n > 0;
            const label = `${urgent ? "⚠ " : ""}${f.label}${n > 0 ? ` ${num(n)}` : ""}`;
            return (
              <Chip
                key={f.key}
                label={label}
                active={filter === f.key}
                onPress={() => onFilterChange(f.key)}
                accessibilityLabel={chipSpokenLabel(f.label, n, urgent)}
              />
            );
          })}
        </View>
      </View>

      {/* Folders are a THIRD axis. Rendered only when the workspace has any —
          the options list always carries "All folders" and "Uncategorised", so
          two entries means "no folders exist" and a control with nothing to
          choose between is worse than no control. Kept mounted while a folder
          filter is ACTIVE even if the folder list read failed, or the operator
          would be stranded inside a filter with no way out. */}
      {folderOptions.length > 2 || folder !== ALL_FOLDERS ? (
        <View style={{ marginTop: 8 }}>
          <ChipRow
            accessibilityLabel={msg("campaigns.folder.a11y")}
            options={folderOptions.map((o) => ({
              value: o.value,
              label: o.label,
              accessibilityLabel: o.accessibilityLabel,
            }))}
            value={folder}
            onChange={onFolderChange}
          />
          {folderCaveat ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                paddingHorizontal: 16,
                marginTop: 6,
                fontFamily: FONT.regular,
              }}
            >
              {folderCaveat}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Sort is a SECOND axis, not another status chip, so it gets its own
          scroller and its own group name — a single wrapped strip of pills
          mixing "Draft" with "Open rate" reads as one incoherent filter. */}
      <View style={{ marginTop: 8 }}>
        {agenda ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              paddingHorizontal: 16,
              fontFamily: FONT.regular,
            }}
          >
            {msg("campaigns.agenda.note")}
          </Text>
        ) : (
          <ChipRow
            accessibilityLabel={msg("campaigns.sort.a11y")}
            options={CAMPAIGN_SORTS.map((s) => ({
              value: s.value,
              label: s.label,
              accessibilityLabel: s.accessibilityLabel,
            }))}
            value={sort}
            onChange={onSortChange}
          />
        )}
        {!agenda && sortCaveat ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              paddingHorizontal: 16,
              marginTop: 6,
              fontFamily: FONT.regular,
            }}
          >
            {sortCaveat}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
