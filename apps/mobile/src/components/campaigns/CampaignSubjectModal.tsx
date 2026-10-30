/**
 * CampaignSubjectModal — edit the campaign's identity fields, or fan the
 * subject out into an A/B test.
 *
 * Fixed here:
 *  - MORE THAN THE SUBJECT IS EDITABLE. Preview text, from-name and reply-to
 *    are all accepted by PATCH /api/v1/campaigns/{id} and were all editable on
 *    desktop; on a phone only the subject was, so a typo'd reply-to found on
 *    the way to a meeting could not be fixed from the device in your hand.
 *    Preview text is the sharpest of the three — it is the line the inbox
 *    renders under the subject.
 *  - The save sends a DIFF, not the whole form, so a sheet left open while
 *    someone edits the same campaign on desktop can only overwrite the fields
 *    its own user actually touched (see lib/campaignFields.ts).
 *  - Outcomes are toasts. Saving a subject no longer costs a tap to dismiss
 *    a modal alert, and failures render through campaignErrorMessage instead
 *    of echoing the transport error.
 *  - The A/B hand-off PUSHES to the new parent's DETAIL screen instead of
 *    router.replace-ing onto its ab-results screen. `replace` popped the
 *    campaign the user was editing out of the stack (back landed on the
 *    list), and the destination necessarily showed "No variants yet" because
 *    the test had not sent — the context was destroyed to reach an empty
 *    screen. The detail screen is where you would then schedule or send it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";

import { ACTIVE_VOICE_PROFILE } from "@/lib/aiVoiceProfile";
import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { CampaignAbFromNamesField } from "@/components/campaigns/CampaignAbFromNamesField";
import { CampaignFieldInput } from "@/components/campaigns/CampaignFieldInput";
import { CampaignIdentityFields } from "@/components/campaigns/CampaignIdentityFields";
import { CampaignSubjectLabLink } from "@/components/campaigns/CampaignSubjectLabLink";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SubjectLineSuggestions } from "@/components/SubjectLineSuggestions";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import { useCampaignAbHandoff } from "@/hooks/useCampaignAbHandoff";
import { useCampaignIdentitySave } from "@/hooks/useCampaignIdentitySave";
import type { CampaignDetail } from "@/hooks/useCampaigns";
import {
  AB_SPLIT_OPTIONS,
  splitCaption,
  splitPercentForKey,
  type AbSplitKey,
} from "@/lib/campaignAbSplit";
import { parseFromNameVariants } from "@/lib/campaignAbVariants";
import {
  CAMPAIGN_SUBJECT_MAX,
  campaignFieldsFrom,
  campaignFieldsPatch,
  validateCampaignFields,
  type CampaignFieldsDraft,
} from "@/lib/campaignFields";
import {
  campaignFromEmailValue,
  fromEmailProblem,
  identitySavePlan,
} from "@/lib/campaignSenderEdit";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";

export function CampaignSubjectModal({
  visible,
  onClose,
  campaign,
  returnFocusRef,
  seed,
  onDraftChange,
}: {
  visible: boolean;
  onClose: () => void;
  campaign: CampaignDetail;
  returnFocusRef?: ReturnFocusRef | undefined;
  /**
   * A durable draft (ECO-03) the person chose to resume, to open with instead
   * of the saved record. Read ONCE, when the sheet becomes visible: it arrives
   * from route state, and re-seeding on every identity change would overwrite
   * what is being typed.
   */
  seed?: CampaignFieldsDraft | undefined;
  /**
   * Reports the in-progress draft up so it can be checkpointed, and null the
   * moment there is nothing unsaved. Optional — the sheet is fully usable
   * without it, and the two A/B tests that render it standalone pass nothing.
   */
  onDraftChange?: ((draft: CampaignFieldsDraft | null) => void) | undefined;
}) {
  const { t } = useTheme();
  const original = useMemo<CampaignFieldsDraft>(
    () => campaignFieldsFrom(campaign),
    [campaign],
  );
  const [draft, setDraft] = useState<CampaignFieldsDraft>(original);
  // The sending address lives at delivery_settings.from_email, and its save
  // path is ONLINE-ONLY (full-map replace) — see lib/campaignSenderEdit.
  const originalFromEmail = useMemo(
    () => campaignFromEmailValue(campaign),
    [campaign],
  );
  const [fromEmail, setFromEmail] = useState(originalFromEmail);
  const [submitted, setSubmitted] = useState(false);
  // "even" omits split_percentage so the server computes 100/N — a different
  // correct answer per arm count, which the client must not duplicate.
  const [split, setSplit] = useState<AbSplitKey>("even");
  const [variantCount, setVariantCount] = useState(0);
  // The G14 multivariate axis: one from-name per line, crossed with the
  // subject variants. Parsed and capped in lib/campaignAbVariants.
  const [abFromNames, setAbFromNames] = useState("");
  const abHandoff = useCampaignAbHandoff({ campaign, onDone: onClose });

  // Read at open time only — see the `seed` prop.
  const seedRef = useRef(seed);
  seedRef.current = seed;

  useEffect(() => {
    if (visible) {
      setDraft(seedRef.current ?? original);
      setFromEmail(originalFromEmail);
      setSubmitted(false);
      setSplit("even");
      setVariantCount(0);
      setAbFromNames("");
    }
  }, [visible, original, originalFromEmail]);

  const subject = draft.subject;
  const setSubject = (next: string) =>
    setDraft((prev) => ({ ...prev, subject: next }));
  const validation = validateCampaignFields(draft);
  const patch = campaignFieldsPatch(original, draft);
  const senderProblem = fromEmailProblem(fromEmail);
  const plan = identitySavePlan(patch, campaign, originalFromEmail, fromEmail);
  const dirty = plan.kind !== "none";
  const showErrors = submitted;

  // Publish the in-progress draft so the route can checkpoint it (ECO-03).
  // Gated on `visible` as well as `dirty`: a closed sheet is not holding
  // unsaved work, and reporting a stale draft from behind the screen would
  // keep re-creating a checkpoint the person has already walked away from.
  useEffect(() => {
    onDraftChange?.(visible && dirty ? draft : null);
  }, [visible, dirty, draft, onDraftChange]);

  // Executes whichever branch the plan calls for — the offline outbox for a
  // field diff, the online-only authoring PATCH for a sender change.
  const identitySave = useCampaignIdentitySave({
    campaignId: campaign.id,
    onSaved: onClose,
  });

  const handleSave = useCallback(() => {
    setSubmitted(true);
    if (!validation.valid || senderProblem) {
      haptics.warning();
      return;
    }
    if (abHandoff.pending) return;
    identitySave.save(plan, draft.subject.trim());
  }, [
    abHandoff.pending,
    draft.subject,
    identitySave,
    plan,
    senderProblem,
    validation.valid,
  ]);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader title="Edit campaign" onClose={onClose} />

      <CampaignFieldInput
        label="Subject line"
        value={draft.subject}
        onChangeText={setSubject}
        placeholder="A clear, specific subject"
        maxLength={CAMPAIGN_SUBJECT_MAX}
        multiline
        {...(showErrors && validation.errors.subject
          ? { error: validation.errors.subject }
          : { hint: "This is what lands in the inbox." })}
      />

      {subject.trim().length >= 10 ? (
        <>
          <SubjectLineSuggestions
            currentSubject={subject}
            // The workspace's learned brand voice. Without this the request
            // ships `context_refs: []` and the model writes in nobody's voice
            // — the same subject line any workspace would get — while the
            // laptop, sending the same sentinel, gets the tenant's.
            voiceProfileId={ACTIVE_VOICE_PROFILE}
            onPickVariant={(text) => setSubject(text)}
            onVariantsChange={setVariantCount}
            onTestAll={(variants) =>
              abHandoff.run(variants, splitPercentForKey(split), {
                fromNameVariants: parseFromNameVariants(abFromNames),
              })
            }
          />
          {abHandoff.blockedReason ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.warning,
                fontSize: 11,
                lineHeight: 16,
                marginTop: 8,
                fontFamily: FONT.regular,
              }}
            >
              {abHandoff.blockedReason}
            </Text>
          ) : (
            <View style={{ marginTop: 12 }}>
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgMuted,
                  fontSize: 12,
                  marginBottom: 6,
                  fontFamily: FONT.regular,
                }}
              >
                Test split
              </Text>
              <SegmentedControl<AbSplitKey>
                options={AB_SPLIT_OPTIONS.map((o) => ({
                  value: o.key,
                  label: o.label,
                }))}
                value={split}
                onChange={setSplit}
                accessibilityLabel="A/B test split percentage"
              />
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  fontSize: 11,
                  lineHeight: 16,
                  marginTop: 6,
                  fontFamily: FONT.regular,
                }}
              >
                {splitCaption(
                  splitPercentForKey(split),
                  Math.max(2, variantCount),
                )}
              </Text>
              <View style={{ marginTop: 12 }}>
                <CampaignAbFromNamesField
                  value={abFromNames}
                  onChangeText={setAbFromNames}
                  subjectCount={Math.max(2, variantCount)}
                />
              </View>
            </View>
          )}
          <CampaignSubjectLabLink
            subject={subject}
            campaignId={campaign.id}
            onNavigate={onClose}
          />
        </>
      ) : (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          Type at least 10 characters to see AI variants.
        </Text>
      )}

      <CampaignIdentityFields
        draft={draft}
        onDraftField={(field, next) =>
          setDraft((prev) => ({ ...prev, [field]: next }))
        }
        fromEmail={fromEmail}
        onFromEmailChange={setFromEmail}
        showErrors={showErrors}
        validation={validation}
        senderProblem={senderProblem}
        onSubmit={handleSave}
      />

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <ActionButton
          label="Cancel"
          onPress={onClose}
          disabled={identitySave.pending || abHandoff.pending}
        />
        <ActionButton
          label={identitySave.pending ? "Saving…" : "Save"}
          primary
          onPress={handleSave}
          disabled={identitySave.pending || abHandoff.pending || !dirty}
        />
      </View>
    </KeyboardFormSheet>
  );
}
