/**
 * AuditFilterBar — the narrowing controls above the log.
 *
 * The distinction this bar has to make honestly, because getting it wrong is
 * how an auditor draws a false conclusion:
 *
 *   - The TIME WINDOW and, where it is safe, the ACTOR chip are pushed to the
 *     server, so "last 24 hours" means every event in the last 24 hours.
 *   - The DESTRUCTIVE toggle and the SEARCH box narrow only what has been
 *     loaded so far — the first is a client-side token heuristic with no
 *     server facet, the second has no server equivalent at all. The copy
 *     under the controls says so rather than letting a filtered view look
 *     exhaustive.
 */
import { SearchField } from "@/components/SearchField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Chip } from "@/components/Chip";
import { Text, View } from "react-native";

import {
  AUDIT_ACTOR_FILTERS,
  type AuditActorFilterKey,
} from "@/lib/auditSeverity";
import {
  AUDIT_WINDOWS,
  type AuditWindowKey,
  auditWindowDescription,
} from "@/lib/auditGrouping";
import { auditTailExplanation } from "@/lib/auditTail";
import { plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditFilterBarProps {
  query: string;
  onQueryChange: (next: string) => void;
  actor: AuditActorFilterKey;
  onActorChange: (next: AuditActorFilterKey) => void;
  windowKey: AuditWindowKey;
  onWindowChange: (next: AuditWindowKey) => void;
  destructiveOnly: boolean;
  onDestructiveChange: (next: boolean) => void;
  /** The named security lens — the same keyword slice apps/web inlines. */
  securityOnly: boolean;
  onSecurityChange: (next: boolean) => void;
  /** Poll for new events and announce the count (never auto-insert). */
  liveTail: boolean;
  onLiveTailChange: (next: boolean) => void;
  /** How many SERVER-side advanced facets are active (0 = none). */
  advancedCount: number;
  /** What the server was asked to narrow by, or null when nothing is. */
  advancedDescription: string | null;
  onOpenAdvanced: () => void;
  /** Open the request-chain lookup (X-Request-ID → everything it did). */
  onOpenTrace: () => void;
  /** Rows after every narrowing, and rows actually loaded. */
  shownCount: number;
  loadedCount: number;
  /** True when more pages exist on the server. */
  hasMore: boolean;
  /** Relative age of the loaded page, e.g. "3m ago". */
  freshness: string | null;
}

export function AuditFilterBar({
  query,
  onQueryChange,
  actor,
  onActorChange,
  windowKey,
  onWindowChange,
  destructiveOnly,
  onDestructiveChange,
  securityOnly,
  onSecurityChange,
  liveTail,
  onLiveTailChange,
  advancedCount,
  advancedDescription,
  onOpenAdvanced,
  onOpenTrace,
  shownCount,
  loadedCount,
  hasMore,
  freshness,
}: AuditFilterBarProps) {
  const { t } = useTheme();
  const narrowed = shownCount !== loadedCount;

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
      <SearchField
        value={query}
        onChangeText={onQueryChange}
        placeholder="Filter loaded events…"
        accessibilityLabel="Filter the loaded audit events"
        {...(query.trim() ? { resultCount: shownCount } : {})}
        resultNoun="event"
      />
      <View style={{ marginTop: 10 }}>
        <SegmentedControl
          options={AUDIT_WINDOWS}
          value={windowKey}
          onChange={onWindowChange}
          accessibilityLabel="Time window"
        />
      </View>
      <View
        style={{ flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" }}
      >
        {AUDIT_ACTOR_FILTERS.map((f) => (
          <Chip
            key={f.key}
            label={f.label}
            active={actor === f.key}
            onPress={() => onActorChange(f.key)}
          />
        ))}
        <Chip
          label="Destructive"
          active={destructiveOnly}
          accessibilityLabel="Show only destructive actions"
          onPress={() => onDestructiveChange(!destructiveOnly)}
        />
        {/* The named lens the audit asked for: a user should not have to
            know to type "login" to see who signed in. Same keyword slice
            apps/web inlines beside the security controls, so the two
            products agree on what a security event is. */}
        <Chip
          label="Security"
          active={securityOnly}
          accessibilityLabel="Show only security actions: sign-in, MFA, tokens, roles and devices"
          onPress={() => onSecurityChange(!securityOnly)}
        />
        <Chip
          label="Live"
          active={liveTail}
          accessibilityLabel="Check for new events automatically"
          onPress={() => onLiveTailChange(!liveTail)}
        />
        {/* The four extra SERVER facets (action / resource / actor label).
            Unlike search and Destructive these narrow the query itself, so
            they cover the full window, not just the loaded pages. */}
        <Chip
          label={advancedCount > 0 ? `Server filters (${advancedCount})` : "Server filters"}
          active={advancedCount > 0}
          accessibilityLabel={
            advancedCount > 0
              ? `Server-side filters, ${advancedCount} active`
              : "Server-side filters: action, resource and actor"
          }
          onPress={onOpenAdvanced}
        />
        {/* Not a filter: a lookup. An on-call engineer holding an
            X-Request-ID from an error envelope traces what it did. */}
        <Chip
          label="Trace id"
          active={false}
          accessibilityLabel="Trace a request id to every audit row it wrote"
          onPress={onOpenTrace}
        />
      </View>
      {advancedDescription ? (
        <Text
          {...typeCap("caption")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
            marginTop: 8,
          }}
        >
          {advancedDescription}
        </Text>
      ) : null}
      {liveTail ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
            marginTop: 8,
          }}
        >
          {auditTailExplanation(true)}
        </Text>
      ) : null}
      {loadedCount > 0 ? (
        <View style={{ marginTop: 10, gap: 3 }}>
          <Text
            {...typeCap("label")}
            accessibilityLabel={`${plural(shownCount, "event")} shown${
              narrowed ? ", narrowed" : ""
            }${freshness ? `, loaded ${freshness}` : ""}`}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("label"),
            }}
          >
            {`${plural(shownCount, "event")} shown${narrowed ? " (narrowed)" : ""}`}
            {freshness ? ` · loaded ${freshness}` : ""}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {`Window covers ${auditWindowDescription(windowKey)}. `}
            {hasMore
              ? "Scroll to load older events; search and the Destructive toggle only narrow what is loaded."
              : "Search and the Destructive toggle only narrow what is loaded."}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
