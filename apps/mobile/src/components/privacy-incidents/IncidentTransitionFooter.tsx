/**
 * IncidentTransitionFooter — the action rail that MOVES the incident state
 * machine, with the two protections the endpoint demands done honestly:
 *
 *   1. AN OPERATOR-SUPPLIED REASON. Picking a move opens a bounded reason
 *      draft; the reason travels with the transition and lands in the audit
 *      ledger verbatim. It is preserved through a rejected attempt — a
 *      conflict must never eat the operator's words.
 *   2. `expected_from` FROM A FRESH READ. Picking a move triggers a re-read of
 *      the record (`onFreshReadNeeded`); confirmation is withheld while that
 *      read is in flight, and the asserted from-state prefers the VERIFIED
 *      detail over the possibly-stale list row (lib/privacyIncidentWrite
 *      `transitionExpectedFrom`). A server 409 (`stale_incident_state`) is
 *      then a genuine race, answered by another re-read — with the reason
 *      still on screen.
 *
 * CLOSURE STAYS DISABLED with its server-wide release hold, exactly as
 * before. A state this build does not recognise still yields no options.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { useToast } from "@/components/Toast";
import { settingsInputStyle } from "@/components/settings/FormControls";
import { useTransitionPrivacyIncident } from "@/hooks/usePrivacyIncidents";
import { useAnnounceOnChange } from "@/lib/a11y";
import { transitionLabel } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  INCIDENT_STATE_LABEL,
  INCIDENT_TRANSITIONS,
  incidentTransitionError,
  incidentTransitionOptions,
  type IncidentTransitionOption,
} from "@/lib/privacyIncidentPolicy";
import type { IncidentState, PrivacyIncident } from "@/lib/privacyIncidents";
import {
  incidentReasonIssue,
  transitionExpectedFrom,
  transitionNeedsFreshRead,
} from "@/lib/privacyIncidentWrite";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface IncidentTransitionFooterProps {
  incident: PrivacyIncident;
  /** Status from the VERIFIED detail read only; null while unverified. */
  verifiedStatus: IncidentState | null;
  /** True while the mandatory re-read is in flight. */
  verifying: boolean;
  /** False when the session may not write (offline, role) — rail goes inert. */
  canTransition: boolean;
  /** Why the rail is inert, when it is. */
  notice: string | null;
  /** Ask the owner queries to re-read the record before/after a conflict. */
  onFreshReadNeeded: () => void;
}

export function IncidentTransitionFooter(props: IncidentTransitionFooterProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const transition = useTransitionPrivacyIncident();
  const [target, setTarget] = useState<IncidentState | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The alert role below is silent on iOS; this is what VoiceOver hears.
  useAnnounceOnChange(error);

  const options = incidentTransitionOptions(props.incident);
  const expectedFrom = transitionExpectedFrom(
    props.verifiedStatus,
    props.incident.status,
  );
  // The record may have moved under us between picking and confirming: if the
  // freshly-verified state no longer offers the picked move, say so instead of
  // sending a request the server can only refuse.
  const targetStillValid =
    target !== null &&
    expectedFrom !== null &&
    INCIDENT_TRANSITIONS[expectedFrom].includes(target);

  const pick = (option: IncidentTransitionOption) => {
    haptics.tap();
    setTarget(option.to);
    setError(null);
    // Re-read before deciding: the confirm below is withheld until this lands.
    props.onFreshReadNeeded();
  };

  const cancel = () => {
    setTarget(null);
    setReason("");
    setError(null);
  };

  const confirm = () => {
    if (target === null) return;
    const issue = incidentReasonIssue(reason);
    if (issue) {
      setError(issue);
      return;
    }
    if (expectedFrom === null || !targetStillValid) {
      setError(
        "The incident's current state could not be verified, or no longer offers this move. Review the record and pick again.",
      );
      return;
    }
    haptics.tap();
    setError(null);
    transition.mutate(
      {
        incidentId: props.incident.id,
        to: target,
        reason: reason.trim(),
        expectedFrom,
      },
      {
        onSuccess: (result) => {
          haptics.success();
          toast({
            kind: "success",
            message: `Recorded: now ${INCIDENT_STATE_LABEL[target].toLowerCase()}. Your reason is in the ledger.`,
          });
          setTarget(null);
          setReason("");
          void result;
        },
        onError: (err) => {
          haptics.error();
          setError(incidentTransitionError(err));
          const code = (err as { code?: string }).code;
          // The reason is deliberately NOT cleared: a conflict re-reads the
          // record; the operator reviews and re-confirms the same words.
          if (transitionNeedsFreshRead(code)) props.onFreshReadNeeded();
        },
      },
    );
  };

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 8,
        gap: 8,
      }}
    >
      {props.notice ? <Caption tone="muted">{props.notice}</Caption> : null}
      {options.length === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          This incident is closed. The workflow has no move left from here.
        </Text>
      ) : target === null ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {options.map((option) => (
            <RailButton
              key={option.to}
              option={option}
              enabled={props.canTransition && option.allowed}
              onPick={pick}
            />
          ))}
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <Caption tone="muted">
            {props.verifying || expectedFrom === null
              ? "Verifying the record's current state…"
              : targetStillValid
                ? `Recording ${transitionLabel(
                    INCIDENT_STATE_LABEL[expectedFrom].toLowerCase(),
                    INCIDENT_STATE_LABEL[target].toLowerCase(),
                  )}. A reason is required and becomes part of the permanent ledger.`
                : `The record is now ${INCIDENT_STATE_LABEL[expectedFrom].toLowerCase()} and no longer offers this move. Cancel and review.`}
          </Caption>
          <TextInput
            {...typeCap("body")}
            value={reason}
            onChangeText={setReason}
            editable={!transition.isPending}
            multiline
            placeholder="Why is this state changing?"
            placeholderTextColor={t.fgSubtle}
            accessibilityLabel="Reason for the state change"
            style={[settingsInputStyle(t), { minHeight: 64 }]}
          />
          {error ? (
            <Text
              accessibilityRole="alert"
              {...typeCap("caption")}
              style={{
                color: t.danger,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {error}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <FooterAction label="Cancel" onPress={cancel} />
            <FooterAction
              label={
                transition.isPending
                  ? "Recording…"
                  : `Confirm ${target ? INCIDENT_STATE_LABEL[target].toLowerCase() : ""}`
              }
              emphasis
              disabled={
                transition.isPending ||
                props.verifying ||
                !targetStillValid ||
                !props.canTransition
              }
              onPress={confirm}
            />
          </View>
        </View>
      )}
    </View>
  );
}

function Caption({
  children,
  tone,
}: {
  children: string;
  tone: "muted";
}) {
  const { t } = useTheme();
  void tone;
  return (
    <Text
      accessibilityLabel={children}
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function RailButton({
  option,
  enabled,
  onPick,
}: {
  option: IncidentTransitionOption;
  enabled: boolean;
  onPick: (option: IncidentTransitionOption) => void;
}) {
  const { t } = useTheme();
  const spoken = option.blockedReason
    ? `${option.label}. ${option.blockedReason}`
    : option.label;
  return (
    <Pressable
      disabled={!enabled}
      onPress={() => onPick(option)}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ disabled: !enabled }}
      style={{
        minHeight: 44,
        paddingHorizontal: 14,
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: option.destructive ? t.danger : t.borderSubtle,
        backgroundColor: t.surface,
        opacity: enabled ? 1 : 0.5,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: option.destructive ? t.danger : t.fg,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {option.label}
      </Text>
    </Pressable>
  );
}

function FooterAction({
  label,
  onPress,
  emphasis = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  emphasis?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        flex: emphasis ? 1 : undefined,
        minHeight: 44,
        paddingHorizontal: 14,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 10,
        borderWidth: emphasis ? 0 : 1,
        borderColor: t.borderSubtle,
        backgroundColor: emphasis
          ? disabled
            ? t.bgSubtle
            : t.accent
          : t.surface,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: emphasis ? (disabled ? t.fgSubtle : t.accentFg) : t.fg,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
