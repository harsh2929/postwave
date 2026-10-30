/**
 * PiiFindingDecisionSheet — decide one Shadow-PII finding, with the receipt
 * contract the server enforces.
 *
 * Desktop's PIIFindingDecisionForm, in phone form: choose the outcome
 * (Reviewed / Dismissed), choose a reason FROM THAT OUTCOME'S taxonomy (the
 * two lists deliberately do not overlap — confirming personal data and
 * dismissing a false positive are different compliance decisions), explain it
 * in a comment that must NOT contain raw personal data, and cite a typed
 * evidence reference. Validation rules live in lib/subscriberPiiFindings.ts,
 * where they are unit-tested against pii_scanner's NormalizeAndValidate;
 * this file is only the form.
 *
 * Switching outcome CLEARS the chosen reason rather than keeping an invalid
 * one selected — a "Dismissed + confirmed_pii" pair must be unrepresentable
 * in the UI, not merely rejected on submit.
 */
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { Chip } from "@/components/Chip";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import {
  ModalHeader,
  SubActionButton,
} from "@/components/subscriber/SubActionButton";
import { FONT } from "@/lib/fonts";
import { keyboardDismiss } from "@/lib/keyboardChain";
import {
  piiDecisionProblem,
  piiReasonsFor,
  piiTypeLabel,
  type PiiDecisionDraft,
  type PiiFindingRow,
} from "@/lib/subscriberPiiFindings";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

function FieldLabel({ text, t }: { text: string; t: ThemeTokens }) {
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: t.fgMuted,
        ...typeStyle("label"),
        marginTop: 12,
        marginBottom: 6,
        fontFamily: FONT.medium,
      }}
    >
      {text}
    </Text>
  );
}

const EMPTY_DRAFT: PiiDecisionDraft = {
  outcome: "reviewed",
  reason: "",
  comment: "",
  evidenceReference: "",
};

export function PiiFindingDecisionSheet({
  finding,
  busy,
  submitError,
  onClose,
  onSubmit,
}: {
  /** The finding under review, or null when the sheet is closed. */
  finding: PiiFindingRow | null;
  busy: boolean;
  /** The server's rejection, verbatim under the form. */
  submitError?: string | undefined;
  onClose: () => void;
  onSubmit: (draft: PiiDecisionDraft) => void;
}) {
  const { t } = useTheme();
  const [draft, setDraft] = useState<PiiDecisionDraft>(EMPTY_DRAFT);
  const [attempted, setAttempted] = useState(false);
  const visible = finding !== null;

  // Re-seed per finding: a decision's rationale is not transferable.
  useEffect(() => {
    if (visible) {
      setDraft(EMPTY_DRAFT);
      setAttempted(false);
    }
  }, [visible, finding?.id]);

  const problem = piiDecisionProblem(draft);
  const shownProblem = attempted ? problem : null;
  const reasons = piiReasonsFor(draft.outcome);
  const chosen = reasons.find((r) => r.value === draft.reason);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Decide this PII finding"
    >
      <ModalHeader title="Decide this finding" onClose={onClose} t={t} />
      {finding ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {`${piiTypeLabel(finding.detectedType)} detected in “${finding.fieldName}”. The decision commits an immutable review receipt; the matched value itself never appears here.`}
        </Text>
      ) : null}

      <FieldLabel text="Outcome" t={t} />
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip
          label="Reviewed"
          active={draft.outcome === "reviewed"}
          onPress={() =>
            setDraft((d) =>
              d.outcome === "reviewed"
                ? d
                : { ...d, outcome: "reviewed", reason: "" },
            )
          }
          accessibilityLabel="Outcome: Reviewed — the finding is confirmed personal data"
        />
        <Chip
          label="Dismissed"
          active={draft.outcome === "dismissed"}
          onPress={() =>
            setDraft((d) =>
              d.outcome === "dismissed"
                ? d
                : { ...d, outcome: "dismissed", reason: "" },
            )
          }
          accessibilityLabel="Outcome: Dismissed — the finding is not a real exposure"
        />
      </View>

      <FieldLabel text="Reason" t={t} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {reasons.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            active={draft.reason === option.value}
            onPress={() => setDraft((d) => ({ ...d, reason: option.value }))}
            accessibilityLabel={`Reason: ${option.label}`}
          />
        ))}
      </View>
      {chosen?.description ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {chosen.description}
        </Text>
      ) : null}

      <FieldLabel text="Comment" t={t} />
      <TextInput
        value={draft.comment}
        onChangeText={(comment) => setDraft((d) => ({ ...d, comment }))}
        placeholder="What was decided and why — never the value itself"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Comment"
        autoCapitalize="sentences"
        autoCorrect={false}
        multiline
        {...keyboardDismiss()}
        {...typeCap("body")}
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          minHeight: 64,
          textAlignVertical: "top",
          fontFamily: FONT.regular,
          fontSize: fontSizeFor("body"),
        }}
      />

      <FieldLabel text="Evidence reference" t={t} />
      <TextInput
        value={draft.evidenceReference}
        onChangeText={(evidenceReference) =>
          setDraft((d) => ({ ...d, evidenceReference }))
        }
        placeholder="ticket:DPO-123"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Evidence reference"
        autoCapitalize="none"
        autoCorrect={false}
        {...keyboardDismiss()}
        {...typeCap("body")}
        style={{
          color: t.fg,
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          minHeight: 44,
          fontFamily: FONT.regular,
          fontSize: fontSizeFor("body"),
        }}
      />

      {shownProblem || submitError ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {shownProblem ?? submitError}
        </Text>
      ) : null}

      <View style={{ marginTop: 14 }}>
        <SubActionButton
          label={busy ? "Recording…" : "Record decision"}
          onPress={() => {
            setAttempted(true);
            if (problem || busy) return;
            onSubmit(draft);
          }}
          disabled={busy}
          busy={busy}
          t={t}
        />
      </View>
    </KeyboardFormSheet>
  );
}
