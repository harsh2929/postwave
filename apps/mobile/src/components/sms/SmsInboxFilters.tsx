/**
 * SmsInboxFilters — the two filter rows (audience filter, lifecycle slice) of
 * the SMS inbox. Moved out of `app/(tabs)/sms/index.tsx` unchanged to keep the
 * screen under the 450-line source budget; the screen keeps the state.
 */
import { SegmentedControl } from "@/components/SegmentedControl";
import type {
  SmsConversationFilter,
  SmsConversationStatus,
} from "@/lib/smsConversation";
import { plural } from "@/lib/format";

export function SmsInboxFilters({
  filter,
  status,
  unread,
  unknownTotal,
  activeTotal,
  snoozedTotal,
  archivedTotal,
  onFilter,
  onStatus,
}: {
  filter: SmsConversationFilter;
  status: SmsConversationStatus;
  unread: number;
  unknownTotal: number;
  activeTotal: number;
  snoozedTotal: number;
  archivedTotal: number;
  onFilter: (next: SmsConversationFilter) => void;
  onStatus: (next: SmsConversationStatus) => void;
}) {
  return (
    <>
      <SegmentedControl
        options={[
          { value: "all", label: "All" },
          {
            value: "unread",
            label: "Unread",
            ...(unread > 0 ? { badge: unread } : {}),
            ...(unread > 0
              ? {
                  accessibilityLabel: `Unread, ${plural(unread, "conversation")} reported at response cutoff`,
                }
              : {}),
          },
          {
            value: "unknown",
            label: "Unknown",
            ...(unknownTotal ? { badge: unknownTotal } : {}),
          },
        ]}
        value={filter}
        onChange={onFilter}
        accessibilityLabel="Conversation filter"
      />
      <SegmentedControl
        options={[
          { value: "active", label: "Active", badge: activeTotal },
          { value: "snoozed", label: "Snoozed", badge: snoozedTotal },
          { value: "archived", label: "Archived", badge: archivedTotal },
          { value: "any", label: "Any" },
        ]}
        value={status}
        onChange={onStatus}
        accessibilityLabel="Conversation lifecycle"
        scrollable
      />
    </>
  );
}
