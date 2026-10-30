/**
 * TagGroupFilter — the group axis for the tag catalogue.
 *
 * Desktop navigates a large taxonomy by group in a sidebar. The mobile
 * equivalent of a sidebar is a horizontally scrollable chip row, so this
 * sits directly above the sort control and drives the `group_id` server
 * filter useTagCatalogue already forwards.
 *
 * Renders nothing when the workspace has no groups: an "All" chip with no
 * alternatives is a control that cannot do anything.
 */
import { ScrollView, View } from "react-native";

import { Chip } from "@/components/Chip";
import type { TagGroup } from "@/lib/tagGroups";

export function TagGroupFilter({
  groups,
  selectedId,
  onSelect,
}: {
  groups: readonly TagGroup[];
  /** "" means no group filter. */
  selectedId: string;
  onSelect: (groupId: string) => void;
}) {
  if (groups.length === 0) return null;

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexDirection: "row", gap: 6, paddingEnd: 8 }}
      >
        <Chip
          label="All groups"
          active={selectedId === ""}
          onPress={() => onSelect("")}
          accessibilityLabel="Show tags from every group"
        />
        {groups.map((group) => (
          <Chip
            key={group.id}
            label={group.name}
            active={selectedId === group.id}
            onPress={() => onSelect(selectedId === group.id ? "" : group.id)}
            accessibilityLabel={
              selectedId === group.id
                ? `Stop filtering to the ${group.name} group`
                : `Show only tags in the ${group.name} group`
            }
          />
        ))}
      </ScrollView>
    </View>
  );
}
