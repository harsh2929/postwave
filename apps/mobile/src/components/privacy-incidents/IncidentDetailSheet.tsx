/**
 * IncidentDetailSheet — the recorded state of one incident on a read-only
 * mobile surface.
 *
 * A SHEET RATHER THAN A ROUTE, for the same reason AuditAlertDetailSheet is
 * one: the rhythm is open → read → next, and it keeps this surface to a
 * single route file. (The app-wide entity-detail Stack conversion is
 * deliberately deferred; this does not pre-empt it.)
 *
 * IT RE-FETCHES ON OPEN. List rows omit `jurisdiction_resolution`; detail
 * carries the explicit jurisdiction-rules release hold and recognition-only
 * metadata. Neither response determines notification obligations.
 *
 * THE STATE OPTIONS ARE LIVE for non-closure moves: the footer captures the
 * operator's reason and re-reads the record before asserting `expected_from`
 * (see IncidentTransitionFooter). `closed` stays disabled under the
 * server-wide closure release hold.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { IncidentActivityList } from "@/components/privacy-incidents/IncidentActivityList";
import { IncidentDetailFacts } from "@/components/privacy-incidents/IncidentDetailFacts";
import { IncidentTransitionFooter } from "@/components/privacy-incidents/IncidentTransitionFooter";
import { usePageSheetKeyboardOffset } from "@/hooks/usePageSheetKeyboardOffset";
import { FONT } from "@/lib/fonts";
import {
  INCIDENT_DESKTOP_NOTICE,
  incidentSeverityBadge,
  incidentStateBadge,
} from "@/lib/privacyIncidentCopy";
import { incidentClock } from "@/lib/privacyIncidentPolicy";
import type {
  IncidentEvent,
  PrivacyIncident,
  PrivacyIncidentDetail,
} from "@/lib/privacyIncidents";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

export interface IncidentDetailSheetProps {
  /** The list row — always present while the sheet is open. */
  incident: PrivacyIncident | null;
  /** The richer read. null until its release-hold projection lands. */
  detail: PrivacyIncidentDetail | null;
  detailLoading: boolean;
  detailFailed: boolean;
  events: readonly IncidentEvent[];
  eventsLoading: boolean;
  eventsFailed: boolean;
  onClose: () => void;
  /** Whether this session may record a state change right now. */
  canTransition: boolean;
  /** Why the rail is inert when it is (offline / role). */
  transitionNotice: string | null;
  /** Re-read the record (detail + ledger) before/after asserting its state. */
  onFreshReadNeeded: () => void;
  now: number;
}

export function IncidentDetailSheet(props: IncidentDetailSheetProps) {
  const { t } = useTheme();
  const incident = props.incident;
  // A cached detail must not become authoritative while its mandatory reopen
  // refresh is pending or has failed. Fall back to the visibly labelled list
  // row and keep detail-only evidence behind loading/error states.
  const verifiedDetail =
    props.detailLoading || props.detailFailed ? null : props.detail;
  const current = verifiedDetail ?? incident;
  const { onSheetLayout, keyboardVerticalOffset } =
    usePageSheetKeyboardOffset();
  return (
    <ReducedMotionModal
      visible={incident !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        onLayout={onSheetLayout}
      >
        {current === null ? null : (
          // The pageSheet is a view controller presented over the route, so
          // only an avoider inside it can lift the footer's reason field and
          // Confirm above the keyboard — and only if it is told how far below
          // the window's top the card starts (A11Y-2).
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            keyboardVerticalOffset={keyboardVerticalOffset}
          >
            <SheetHeader
              title={current.summary || "Breach incident"}
              onClose={props.onClose}
            />
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
            >
              <Badges incident={current} now={props.now} />
              <IncidentDetailFacts
                incident={current}
                detail={verifiedDetail}
                detailLoading={props.detailLoading}
                detailFailed={props.detailFailed}
                now={props.now}
              />
              <SectionLabel topMargin={20}>Activity</SectionLabel>
              <IncidentActivityList
                events={props.events}
                loading={props.eventsLoading}
                failed={props.eventsFailed}
                now={props.now}
              />
              <View style={{ height: 16 }} />
              <MobileScopeNotice
                title="Scope and release holds"
                body={INCIDENT_DESKTOP_NOTICE}
              />
            </ScrollView>
            <IncidentTransitionFooter
              incident={current}
              verifiedStatus={verifiedDetail?.status ?? null}
              verifying={props.detailLoading}
              canTransition={props.canTransition}
              notice={props.transitionNotice}
              onFreshReadNeeded={props.onFreshReadNeeded}
            />
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function Badges({ incident, now }: { incident: PrivacyIncident; now: number }) {
  const clock = incidentClock(incident, now);
  const severity = incidentSeverityBadge(incident);
  const state = incidentStateBadge(incident);
  return (
    <View
      accessible
      accessibilityLabel={`${severity.spoken}. ${state.spoken}. ${clock.spoken}`}
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
    >
      <Pill label={clock.label} tone={clock.tone} size="md" />
      <Pill label={severity.label} tone={severity.tone} size="md" />
      <Pill label={state.label} tone={state.tone} size="md" />
    </View>
  );
}

function SheetHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: 1,
        gap: 12,
      }}
    >
      <Text
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.display,
          flexShrink: 1,
        }}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        // NOT "Close incident": that is the name of the terminal state
        // transition in the footer, and two controls a screen-reader user
        // cannot tell apart — one that dismisses a sheet and one that closes a
        // breach record — is an accident waiting to be filed into an audit log.
        accessibilityLabel="Close incident details"
        style={{
          paddingHorizontal: 8,
          paddingVertical: 6,
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontFamily: FONT.semibold,
          }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}
