/**
 * CampaignCreateModal — start a campaign from a phone.
 *
 * Mobile previously had exactly three campaign routes (list, detail,
 * ab-results) and no create surface at all: an operator could inspect and
 * send existing work but could never begin anything, which is why the shared
 * empty-state CTA ("Create a campaign") had nowhere to go.
 *
 * Scope is deliberately the same three-to-five short fields desktop's
 * submitCreate validates — name, subject, and the optional preview text /
 * from name / reply-to. Body composition stays on the web; the draft this
 * sheet produces is the thing you finish there, or send from here once a
 * body exists.
 *
 * Wire notes (verified against apps/api/internal/campaigns/authoring_input.go):
 *   - `from_email` is NOT part of the create contract; the sending address
 *     comes from the workspace's verified sender configuration, so this sheet
 *     does not pretend to collect one.
 *   - `status` / `scheduled_at` are rejected with 422; the payload builder in
 *     src/lib/campaignCreate.ts never includes them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { router } from "expo-router";
import { Text, type TextInput, View } from "react-native";

import { EVENTS } from "@postwave/telemetry";

import { ACTIVE_VOICE_PROFILE } from "@/lib/aiVoiceProfile";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { useToast } from "@/components/Toast";
import { SubjectLineSuggestions } from "@/components/SubjectLineSuggestions";
import { CampaignFieldInput } from "@/components/campaigns/CampaignFieldInput";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import { useCreateCampaign } from "@/hooks/useCampaignMutations";
import {
  CAMPAIGN_FROM_NAME_MAX,
  CAMPAIGN_NAME_MAX,
  CAMPAIGN_PREVIEW_MAX,
  CAMPAIGN_SUBJECT_MAX,
  suggestedCampaignName,
  validateCampaignDraft,
} from "@/lib/campaignCreate";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { track } from "@/lib/telemetry";
import { useTheme } from "@/lib/theme";

export function CampaignCreateModal({
  visible,
  onClose,
  canCreate,
  blockedReason,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  /** False for a viewer, an offline device, or a cached session. */
  canCreate: boolean;
  blockedReason?: string | null | undefined;
  /** The control that opened this sheet; focus returns to it on dismiss. */
  returnFocusRef?: { current: unknown } | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const createMutation = useCreateCampaign();

  const [subject, setSubject] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [previewText, setPreviewText] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Field-to-field chaining. The return key used to do nothing on four of
  // these five fields and inserted a newline into the subject on the fifth,
  // so filling this sheet meant five keyboard dismissals. The chain skips
  // nothing: every field is reachable in order, and the last one submits.
  const nameRef = useRef<TextInput | null>(null);
  const previewRef = useRef<TextInput | null>(null);
  const fromNameRef = useRef<TextInput | null>(null);
  const replyToRef = useRef<TextInput | null>(null);

  useEffect(() => {
    if (!visible) return;
    setSubject("");
    setName("");
    setNameTouched(false);
    setPreviewText("");
    setFromName("");
    setReplyTo("");
    setSubmitted(false);
  }, [visible]);

  // The name defaults to the subject so the common case is one field, not
  // two — but stops tracking the moment the operator edits it themselves.
  const handleSubjectChange = useCallback(
    (next: string) => {
      setSubject(next);
      if (!nameTouched) setName(suggestedCampaignName(next));
    },
    [nameTouched],
  );

  const draft = { name, subject, previewText, fromName, replyTo };
  const validation = validateCampaignDraft(draft);
  const showErrors = submitted;

  const handleCreate = useCallback(() => {
    if (!canCreate || createMutation.isPending) return;
    setSubmitted(true);
    const result = validateCampaignDraft({
      name,
      subject,
      previewText,
      fromName,
      replyTo,
    });
    if (!result.valid) {
      haptics.warning();
      return;
    }
    createMutation.mutate(
      { name, subject, previewText, fromName, replyTo },
      {
        onSuccess: (created) => {
          track(EVENTS.CAMPAIGN_CREATED, { source: "mobile_list" });
          onClose();
          toast({ kind: "success", message: "Draft created." });
          if (created?.id) {
            router.push({
              pathname: "/(tabs)/campaigns/[id]",
              params: { id: String(created.id) },
            });
          }
        },
        onError: (err: unknown) => {
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't create the campaign."),
          });
        },
      },
    );
  }, [
    canCreate,
    createMutation,
    fromName,
    name,
    onClose,
    previewText,
    replyTo,
    subject,
    toast,
  ]);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="New campaign"
      {...(returnFocusRef ? { returnFocusRef } : {})}
    >
      <ModalHeader title="New campaign" onClose={onClose} />

      {!canCreate && blockedReason ? (
        <View
          accessible
          accessibilityLabel={blockedReason}
          style={{
            backgroundColor: t.bgSubtle,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 10,
            marginBottom: 14,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              fontSize: 12,
              lineHeight: 17,
              fontFamily: FONT.regular,
            }}
          >
            {blockedReason}
          </Text>
        </View>
      ) : null}

      <CampaignFieldInput
        label="Subject line"
        value={subject}
        onChangeText={handleSubjectChange}
        placeholder="A clear, specific subject"
        maxLength={CAMPAIGN_SUBJECT_MAX}
        multiline
        editable={canCreate}
        nextRef={nameRef}
        {...(showErrors && validation.errors.subject
          ? { error: validation.errors.subject }
          : { hint: "This is what lands in the inbox." })}
      />

      {subject.trim().length >= 10 && canCreate ? (
        <View style={{ marginBottom: 14 }}>
          <SubjectLineSuggestions
            currentSubject={subject}
            // See CampaignSubjectModal: the sentinel the server resolves to
            // this tenant's voice profile. Omitting it is how mobile silently
            // generated in a generic voice while desktop did not.
            voiceProfileId={ACTIVE_VOICE_PROFILE}
            onPickVariant={handleSubjectChange}
          />
        </View>
      ) : null}

      <CampaignFieldInput
        label="Internal name"
        value={name}
        onChangeText={(next) => {
          setNameTouched(true);
          setName(next);
        }}
        placeholder="How you'll find it in the list"
        maxLength={CAMPAIGN_NAME_MAX}
        editable={canCreate}
        inputRef={nameRef}
        nextRef={previewRef}
        {...(showErrors && validation.errors.name
          ? { error: validation.errors.name }
          : { hint: "Only your team sees this." })}
      />

      <CampaignFieldInput
        label="Preview text (optional)"
        value={previewText}
        onChangeText={setPreviewText}
        placeholder="The line under the subject in most inboxes"
        maxLength={CAMPAIGN_PREVIEW_MAX}
        multiline
        editable={canCreate}
        inputRef={previewRef}
        nextRef={fromNameRef}
        {...(showErrors && validation.errors.previewText
          ? { error: validation.errors.previewText }
          : {})}
      />

      <CampaignFieldInput
        label="From name (optional)"
        value={fromName}
        onChangeText={setFromName}
        placeholder="Leave blank to use the workspace default"
        maxLength={CAMPAIGN_FROM_NAME_MAX}
        autoCapitalize="words"
        editable={canCreate}
        inputRef={fromNameRef}
        nextRef={replyToRef}
        {...(showErrors && validation.errors.fromName
          ? { error: validation.errors.fromName }
          : {})}
      />

      <CampaignFieldInput
        label="Reply-to (optional)"
        value={replyTo}
        onChangeText={setReplyTo}
        placeholder="replies@yourdomain.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={canCreate}
        inputRef={replyToRef}
        // Last field in the chain: the return key creates the draft, the same
        // act as the primary button, rather than dropping the keyboard on a
        // form the operator has already finished.
        onSubmitEditing={handleCreate}
        returnKeyType="go"
        {...(showErrors && validation.errors.replyTo
          ? { error: validation.errors.replyTo }
          : {
              hint: "The sending address comes from your verified sender settings.",
            })}
      />

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontSize: 11,
          lineHeight: 16,
          marginBottom: 12,
          fontFamily: FONT.regular,
        }}
      >
        This creates a draft. Add the body on the web app, then schedule or send
        it from here.
      </Text>

      <View
        style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}
      >
        <ActionButton
          label="Cancel"
          onPress={onClose}
          disabled={createMutation.isPending}
        />
        <ActionButton
          label={createMutation.isPending ? "Creating…" : "Create draft"}
          primary
          onPress={handleCreate}
          disabled={!canCreate || createMutation.isPending}
        />
      </View>
    </KeyboardFormSheet>
  );
}
