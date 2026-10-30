/** Read-only, cursor-paged child roster. */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { MobileAgencyChild } from "@/api/agencyReads";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { ChildCard } from "@/components/agency/ChildCard";
import { formatCount } from "@/components/agency/agencyCardStyle";
import { useAnnounceOnChange } from "@/lib/a11y";
import { agencyChildrenEmptyCopy } from "@/lib/agencyAccess";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const NEXT_PAGE_FAILED =
  "The next roster page could not be loaded. The verified rows above are still shown.";

export interface ChildrenSectionProps {
  rows: readonly MobileAgencyChild[];
  notAgency: boolean;
  accessRestricted: boolean;
  unavailable: boolean;
  hasMore: boolean;
  canLoadMore: boolean;
  isFetchingNextPage: boolean;
  isNextPageError: boolean;
  onLoadMore: () => void;
}

export function ChildrenSection({
  rows,
  notAgency,
  accessRestricted,
  unavailable,
  hasMore,
  canLoadMore,
  isFetchingNextPage,
  isNextPageError,
  onLoadMore,
}: ChildrenSectionProps) {
  const { t } = useTheme();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // One stable callback for every card, reading state through the updater so
  // it never goes stale. A per-row arrow defeats ChildCard's memo, and every
  // loaded card re-rendered on each expand (the DmarcReportRow rationale).
  const onToggle = useCallback(
    (id: string) => setExpandedId((current) => (current === id ? null : id)),
    [],
  );
  const nextPageFailed = isNextPageError && rows.length > 0;
  // The banner's alert role is silent on iOS; VoiceOver hears only this.
  useAnnounceOnChange(nextPageFailed ? NEXT_PAGE_FAILED : null);

  return (
    <View>
      {/* GOVERNANCE#55 / CQ-8: the shared heading (see app/(tabs)/agency.tsx);
          the pills ride its right slot rather than a hand-built header row. */}
      <SectionLabel
        topMargin={0}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {rows.length > 0 ? (
              <Pill
                label={`${formatCount(rows.length)} loaded`}
                tone="neutral"
              />
            ) : null}
            {!notAgency && !accessRestricted ? (
              <Pill label="lifecycle held" tone="neutral" />
            ) : null}
          </View>
        }
      >
        Child workspaces
      </SectionLabel>

      {!notAgency && !accessRestricted ? (
        <Note>
          Review-only roster. Creation, unlinking, and stored billing-owner
          changes are unavailable until ownership, onboarding, invoicing, and
          payer handoff can complete safely.
        </Note>
      ) : null}

      {unavailable && !notAgency && !accessRestricted ? (
        <EmptyState
          title="Child roster unavailable"
          description="The roster response could not be verified. No partial or invented workspace list is shown."
        />
      ) : rows.length === 0 ? (
        <EmptyState {...agencyChildrenEmptyCopy(accessRestricted, notAgency)} />
      ) : (
        rows.map((child) => (
          <ChildCard
            key={child.id}
            child={child}
            expanded={expandedId === child.id}
            onToggle={onToggle}
          />
        ))
      )}

      {nextPageFailed ? (
        <View
          accessible
          accessibilityRole="alert"
          style={{
            borderColor: t.danger,
            borderWidth: 1,
            borderRadius: 12,
            padding: 12,
            marginTop: 4,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.medium,
            }}
          >
            {NEXT_PAGE_FAILED}
          </Text>
        </View>
      ) : null}

      {hasMore ? (
        <View style={{ marginTop: 4 }}>
          <Note>
            {canLoadMore
              ? "More linked workspaces are available. Loading another bounded page is always explicit."
              : "More linked workspaces may be available. Reconnect to load the next bounded page."}
          </Note>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              !canLoadMore
                ? "Reconnect to load more child workspaces"
                : isNextPageError
                  ? "Retry loading the next child-workspace page"
                  : "Load more child workspaces"
            }
            accessibilityState={{
              disabled: isFetchingNextPage || !canLoadMore,
              busy: isFetchingNextPage,
            }}
            disabled={isFetchingNextPage || !canLoadMore}
            onPress={onLoadMore}
            style={{
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 12,
              borderWidth: 1,
              borderColor: t.borderSubtle,
              backgroundColor: t.surface,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fg,
                ...typeStyle("control"),
                fontFamily: FONT.medium,
              }}
            >
              {!canLoadMore
                ? "Reconnect to load more"
                : isFetchingNextPage
                  ? "Loading…"
                  : isNextPageError
                    ? "Retry next page"
                    : "Load more"}
            </Text>
          </Pressable>
        </View>
      ) : rows.length > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 4,
          }}
        >
          End of the loaded child roster.
        </Text>
      ) : null}
    </View>
  );
}

function Note({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        marginBottom: 8,
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}
