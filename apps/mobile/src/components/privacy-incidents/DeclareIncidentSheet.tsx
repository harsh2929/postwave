/**
 * DeclareIncidentSheet — open the operational record for a possible breach,
 * from the device the bad news actually arrives on.
 *
 * DELIBERATELY MINIMAL: severity + summary. The server accepts a bare record
 * (incidents.go Create requires only those two) and stamps the legacy
 * operational target from `detected_at = now`. Scope fields — regions,
 * categories, jurisdictions, subject counts — are desk work that can follow;
 * the record and its clock should not wait for them.
 *
 * THE IDEMPOTENCY KEY BELONGS TO THE DRAFT. The endpoint requires an
 * Idempotency-Key precisely so an AMBIGUOUS failure (network died mid-flight,
 * gateway 5xx) can be retried without opening a second breach record. So:
 * one key per draft, kept across ambiguous failures — during which the fields
 * LOCK, because editing the payload under a reused key would replay-match a
 * request that never committed — and rotated after a definite rejection or a
 * success (lib/privacyIncidentWrite `declareKeyAfterFailure`).
 *
 * ONLINE-ONLY. Never the offline outbox: a declaration replayed later would
 * invent the moment-of-knowledge evidence this record exists to capture. The
 * header verb is gated, but the sheet can outlive the connection it opened
 * on, so it reads the same `canDeclare` gate itself: offline the submit goes
 * inert with the reason in the sheet, and the mutation runs in network mode
 * "always" so even a sub-render race fails instead of pausing.
 *
 * ONLY AN OPEN SHEET SPEAKS. The screen keeps this component mounted and feeds
 * it the live gate whether or not the sheet is showing, so the announcement is
 * keyed to `visible`: a closed sheet has nothing on screen to speak for, and
 * would talk over the register's own offline message.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import * as Crypto from "expo-crypto";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { useToast } from "@/components/Toast";
import { settingsInputStyle } from "@/components/settings/FormControls";
import { useDeclarePrivacyIncident } from "@/hooks/usePrivacyIncidents";
import { liveRegionProps, useAnnounceOnChange } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { INCIDENT_TRANSITION_OFFLINE_NOTICE } from "@/lib/privacyIncidentPolicy";
import type { IncidentSeverity } from "@/lib/privacyIncidents";
import {
  declareKeyAfterFailure,
  INCIDENT_DECLARE_AMBIGUOUS_NOTICE,
  INCIDENT_SEVERITY_OPTIONS,
  incidentSummaryIssue,
} from "@/lib/privacyIncidentWrite";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * The sheet's own sentence for the offline gate. The screen's gate is worded
 * for the transition rail — a state move recorded with a reason — and a
 * declaration has neither.
 */
export const INCIDENT_DECLARE_OFFLINE_NOTICE =
  "Declaring needs a live connection. The record and its clock start the moment the server receives it — it is never queued to replay later, because a replayed declaration would misstate when the incident became known.";

/**
 * What the sheet says while its gate is closed: offline in its own words, any
 * other stated reason as given, and nothing at all for a gate closed without
 * one (the session role still resolving) — an inert button, never a false
 * "the connection is down".
 */
export function declareGateNotice(
  canDeclare: boolean,
  notice: string | null,
): string | null {
  if (canDeclare) return null;
  return notice === INCIDENT_TRANSITION_OFFLINE_NOTICE
    ? INCIDENT_DECLARE_OFFLINE_NOTICE
    : notice;
}

export interface DeclareIncidentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The screen's write gate (online + role), read live while the sheet is open. */
  canDeclare: boolean;
  /** Why the gate is closed, when it is. */
  notice: string | null;
}

export function DeclareIncidentSheet({
  visible,
  onClose,
  canDeclare,
  notice,
}: DeclareIncidentSheetProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const declare = useDeclarePrivacyIncident();
  const [severity, setSeverity] = useState<IncidentSeverity>("investigating");
  const [summary, setSummary] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const keyRef = useRef<string | null>(null);
  // While the gate is closed its reason outranks a stale validation line: it
  // is the one thing the operator can act on, and it explains the inert button.
  const shownIssue = declareGateNotice(canDeclare, notice) ?? issue;
  useAnnounceOnChange(visible ? shownIssue : null);

  const reset = () => {
    setSummary("");
    setSeverity("investigating");
    setIssue(null);
    setAmbiguous(false);
    keyRef.current = null;
  };

  const onSubmit = () => {
    const summaryIssue = incidentSummaryIssue(summary);
    if (summaryIssue) {
      setIssue(summaryIssue);
      return;
    }
    // The backstop behind the disabled button, before a key is minted: a
    // refused attempt leaves no request behind. The sheet already shows any
    // stated reason, so nothing is stored that would outlive the reconnect.
    if (!canDeclare) return;
    haptics.tap();
    setIssue(null);
    if (!keyRef.current) keyRef.current = Crypto.randomUUID();
    declare.mutate(
      { severity, summary: summary.trim(), idempotencyKey: keyRef.current },
      {
        onSuccess: () => {
          haptics.success();
          toast({
            kind: "success",
            message:
              "Preliminary incident record declared. Its operational clock is running.",
          });
          reset();
          onClose();
        },
        onError: (err) => {
          haptics.error();
          const status = (err as { status?: number }).status;
          if (declareKeyAfterFailure({ status }) === "reuse") {
            // Outcome unknown — keep the key, lock the payload it signs.
            setAmbiguous(true);
            setIssue(INCIDENT_DECLARE_AMBIGUOUS_NOTICE);
            return;
          }
          // Definite rejection: nothing was written; the next attempt is a
          // new request under a new key.
          keyRef.current = null;
          setAmbiguous(false);
          setIssue(
            (err as Error).message || "The record could not be declared.",
          );
        },
      },
    );
  };

  const busy = declare.isPending;
  const inert = busy || !canDeclare;
  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
      >
        <Header onClose={onClose} />
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            This opens the operational record and starts the legacy 72-hour
            operational target now. Scope, jurisdictions and subject counts can
            be completed from the web admin — the record should not wait for
            them.
          </Text>

          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.semibold,
            }}
          >
            Severity
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {INCIDENT_SEVERITY_OPTIONS.map((option) => {
              const selected = option.value === severity;
              return (
                <Pressable
                  key={option.value}
                  disabled={busy || ambiguous}
                  onPress={() => setSeverity(option.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: busy || ambiguous }}
                  accessibilityLabel={`Severity ${option.label}. ${option.hint}`}
                  style={{
                    minHeight: 44,
                    paddingHorizontal: 14,
                    justifyContent: "center",
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: selected ? t.accent : t.borderSubtle,
                    backgroundColor: selected ? t.bgSubtle : t.surface,
                  }}
                >
                  <Text
                    {...typeCap("control")}
                    style={{
                      color: selected ? t.accent : t.fg,
                      ...typeStyle("control"),
                      fontFamily: FONT.semibold,
                    }}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <TextInput
            {...typeCap("body")}
            value={summary}
            onChangeText={setSummary}
            editable={!busy && !ambiguous}
            multiline
            numberOfLines={4}
            placeholder="What happened, as far as is known right now?"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="Incident summary"
            style={[settingsInputStyle(t), { minHeight: 96 }]}
          />
          {shownIssue ? (
            <Text
              {...liveRegionProps()}
              {...typeCap("caption")}
              style={{
                color: t.danger,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {shownIssue}
            </Text>
          ) : null}

          <Pressable
            onPress={onSubmit}
            disabled={inert}
            accessibilityRole="button"
            accessibilityLabel={
              ambiguous
                ? "Retry declaring with the same request key"
                : "Declare the preliminary incident record"
            }
            accessibilityState={{ disabled: inert }}
            style={{
              minHeight: 48,
              justifyContent: "center",
              alignItems: "center",
              borderRadius: 12,
              backgroundColor: inert ? t.bgSubtle : t.accent,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: inert ? t.fgSubtle : t.accentFg,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {busy
                ? "Declaring…"
                : ambiguous
                  ? "Retry the same request"
                  : "Declare incident"}
            </Text>
          </Pressable>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Declared records cannot be deleted from any client. This is an
            operational record, not a legal determination.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  const { t } = useTheme();
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
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.display,
          flexShrink: 1,
        }}
      >
        Declare incident
      </Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close the declare sheet"
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
          Cancel
        </Text>
      </Pressable>
    </View>
  );
}
