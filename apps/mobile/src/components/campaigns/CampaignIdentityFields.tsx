/**
 * CampaignIdentityFields — the identity half of the subject sheet.
 *
 * Preview text, from-name (with the AI suggestions row), the SENDING address
 * and reply-to, followed by the assembled inbox-row preview — the exact
 * artifact those fields become. Extracted from CampaignSubjectModal so the
 * sheet stays inside the source budgets; all state stays with the sheet, this
 * renders it.
 *
 * The from-ADDRESS is the one field here whose save path is online-only (the
 * delivery_settings full replace — lib/campaignSenderEdit); its hint says so,
 * because the other fields queue for replay and this one refuses to.
 */
import { useRef } from "react";
import { View, type TextInput } from "react-native";

import { CampaignFieldInput } from "@/components/campaigns/CampaignFieldInput";
import { CampaignInboxRowPreview } from "@/components/campaigns/CampaignInboxRowPreview";
import { FromNameSuggestionsRow } from "@/components/campaigns/FromNameSuggestionsRow";
import {
  CAMPAIGN_FROM_NAME_MAX,
  CAMPAIGN_PREVIEW_MAX,
  type CampaignFieldsDraft,
  type CampaignFieldsValidation,
} from "@/lib/campaignFields";

export interface CampaignIdentityFieldsProps {
  draft: CampaignFieldsDraft;
  onDraftField: (field: keyof CampaignFieldsDraft, next: string) => void;
  fromEmail: string;
  onFromEmailChange: (next: string) => void;
  showErrors: boolean;
  validation: CampaignFieldsValidation;
  /** From lib/campaignSenderEdit.fromEmailProblem — null when acceptable. */
  senderProblem: string | null;
  /** The sheet's save handler, for return-key submit on the last field. */
  onSubmit: () => void;
}

export function CampaignIdentityFields({
  draft,
  onDraftField,
  fromEmail,
  onFromEmailChange,
  showErrors,
  validation,
  senderProblem,
  onSubmit,
}: CampaignIdentityFieldsProps) {
  // Field-to-field chaining. The refs live here because only these fields
  // ever chain to each other.
  const previewRef = useRef<TextInput | null>(null);
  const fromNameRef = useRef<TextInput | null>(null);
  const replyToRef = useRef<TextInput | null>(null);

  return (
    <View style={{ marginTop: 16 }}>
      <CampaignFieldInput
        label="Preview text"
        value={draft.previewText}
        onChangeText={(next) => onDraftField("previewText", next)}
        placeholder="The line under the subject in most inboxes"
        maxLength={CAMPAIGN_PREVIEW_MAX}
        multiline
        inputRef={previewRef}
        nextRef={fromNameRef}
        {...(showErrors && validation.errors.previewText
          ? { error: validation.errors.previewText }
          : {})}
      />
      <CampaignFieldInput
        label="From name"
        value={draft.fromName}
        onChangeText={(next) => onDraftField("fromName", next)}
        placeholder="Leave blank to use the workspace default"
        maxLength={CAMPAIGN_FROM_NAME_MAX}
        autoCapitalize="words"
        inputRef={fromNameRef}
        nextRef={replyToRef}
        {...(showErrors && validation.errors.fromName
          ? { error: validation.errors.fromName }
          : {})}
      />
      <FromNameSuggestionsRow
        current={draft.fromName}
        onApply={(next) => onDraftField("fromName", next)}
      />
      <CampaignFieldInput
        label="From address"
        value={fromEmail}
        onChangeText={onFromEmailChange}
        placeholder="Leave blank to use the workspace default sender"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        {...(showErrors && senderProblem
          ? { error: senderProblem }
          : {
              hint: "The sending address. Saving a change here needs a connection — it never queues for later.",
            })}
      />
      <CampaignFieldInput
        label="Reply-to"
        value={draft.replyTo}
        onChangeText={(next) => onDraftField("replyTo", next)}
        placeholder="replies@yourdomain.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        inputRef={replyToRef}
        onSubmitEditing={onSubmit}
        {...(showErrors && validation.errors.replyTo
          ? { error: validation.errors.replyTo }
          : { hint: "Where replies land." })}
      />
      <CampaignInboxRowPreview
        input={{
          fromName: draft.fromName,
          fromEmail,
          subject: draft.subject,
          previewText: draft.previewText,
        }}
      />
    </View>
  );
}
