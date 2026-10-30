/**
 * ConsentEvidenceSheet — the phone's version of desktop's consent review
 * modal, shared by the profile Resubscribe flow and the channel-consent card.
 *
 * A consent GRANT is the one write on this profile that must never be a bare
 * status flip: it creates a marketing permission an auditor will later ask
 * about. So instead of desktop's ten-field modal this sheet asks for the same
 * envelope in phone form — three vocabulary choices as chip rows, four short
 * text fields — and refuses to submit until the envelope is whole. The
 * validation and the wire shapes live in src/lib/subscriberConsentEvidence.ts
 * where they are unit-tested; this file is only the form.
 *
 * The captured-at timestamp is seeded to the moment the sheet OPENS: on a
 * phone the operator is recording a decision that just happened on the call,
 * and the seeded value is printed so it is a stated fact rather than a hidden
 * default.
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
import { dateTime } from "@/lib/format";
import {
  consentEvidenceProblem,
  emptyConsentEvidenceDraft,
  CONSENT_EVIDENCE_CHANNELS,
  CONSENT_EVIDENCE_SOURCES,
  CONSENT_LEGAL_BASES,
  type ConsentEvidenceDraft,
  type ConsentVocabOption,
} from "@/lib/subscriberConsentEvidence";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";

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

function VocabRow({
  label,
  options,
  value,
  onChange,
  t,
}: {
  label: string;
  options: readonly ConsentVocabOption[];
  value: string;
  onChange: (next: string) => void;
  t: ThemeTokens;
}) {
  return (
    <View>
      <FieldLabel text={label} t={t} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {options.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            active={value === option.value}
            onPress={() => onChange(option.value)}
            accessibilityLabel={`${label}: ${option.label}`}
          />
        ))}
      </View>
    </View>
  );
}

function EvidenceInput({
  label,
  value,
  onChangeText,
  placeholder,
  t,
  autoCapitalize = "none",
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  t: ThemeTokens;
  autoCapitalize?: "none" | "characters" | "sentences";
  multiline?: boolean;
}) {
  return (
    <View>
      <FieldLabel text={label} t={t} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        multiline={multiline}
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
          minHeight: multiline ? 64 : 44,
          textAlignVertical: multiline ? "top" : "center",
          fontFamily: FONT.regular,
          fontSize: fontSizeFor("body"),
        }}
      />
    </View>
  );
}

export function ConsentEvidenceSheet({
  visible,
  title,
  subtitle,
  sources = CONSENT_EVIDENCE_SOURCES,
  requireEvidence,
  submitLabel,
  busy,
  submitError,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  /** What this review will do, stated before the form. */
  subtitle: string;
  /** Vocabulary of acceptable provenance for THIS write. */
  sources?: readonly ConsentVocabOption[];
  /** Grants demand a durable artifact; revokes do not. */
  requireEvidence: boolean;
  submitLabel: string;
  busy: boolean;
  /** The server's rejection, verbatim under the form. */
  submitError?: string | undefined;
  onClose: () => void;
  onSubmit: (draft: ConsentEvidenceDraft) => void;
}) {
  const { t } = useTheme();
  const [draft, setDraft] = useState<ConsentEvidenceDraft>(
    emptyConsentEvidenceDraft,
  );
  const [attempted, setAttempted] = useState(false);

  // Re-seed on every open so a review never inherits the previous grant's
  // envelope — evidence for THAT decision is not evidence for this one.
  useEffect(() => {
    if (visible) {
      setDraft(emptyConsentEvidenceDraft());
      setAttempted(false);
    }
  }, [visible]);

  const problem = consentEvidenceProblem(draft, {
    sources,
    requireEvidence,
  });
  const shownProblem = attempted ? problem : null;
  const set = (patch: Partial<ConsentEvidenceDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={title}
    >
      <ModalHeader title={title} onClose={onClose} t={t} />
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {subtitle}
      </Text>

      <VocabRow
        label="Evidence source"
        options={sources}
        value={draft.source}
        onChange={(source) => set({ source })}
        t={t}
      />
      <VocabRow
        label="Captured via"
        options={CONSENT_EVIDENCE_CHANNELS}
        value={draft.channel}
        onChange={(channel) => set({ channel })}
        t={t}
      />
      <VocabRow
        label="Legal basis"
        options={CONSENT_LEGAL_BASES}
        value={draft.legalBasis}
        onChange={(legalBasis) => set({ legalBasis })}
        t={t}
      />

      <EvidenceInput
        label="Jurisdiction"
        value={draft.jurisdiction}
        onChangeText={(jurisdiction) =>
          set({ jurisdiction: jurisdiction.toUpperCase() })
        }
        placeholder="EU, GB, US-CA…"
        autoCapitalize="characters"
        t={t}
      />
      <EvidenceInput
        label={
          requireEvidence
            ? "Evidence reference"
            : "Evidence reference (optional)"
        }
        value={draft.evidence}
        onChangeText={(evidence) => set({ evidence })}
        placeholder="ticket:SUP-1234, call recording id, form URL…"
        t={t}
      />
      <EvidenceInput
        label="Reason"
        value={draft.reason}
        onChangeText={(reason) => set({ reason })}
        placeholder="Why this is being recorded"
        autoCapitalize="sentences"
        multiline
        t={t}
      />
      <EvidenceInput
        label="Policy version"
        value={draft.policyVersion}
        onChangeText={(policyVersion) => set({ policyVersion })}
        placeholder="e.g. privacy-2026-05"
        t={t}
      />

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 10,
          fontFamily: FONT.regular,
        }}
      >
        {`Recorded as captured at ${dateTime(draft.capturedAt)} by you.`}
      </Text>

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
          label={busy ? "Recording…" : submitLabel}
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
