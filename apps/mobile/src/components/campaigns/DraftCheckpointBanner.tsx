/**
 * DraftCheckpointBanner — the visible half of ECO-03 on a phone: what a
 * durable draft looks like when this is the second device you picked up.
 *
 * Three states, deliberately distinct. Collapsing them is the failure the
 * server's 409 body was designed to let a client avoid:
 *
 *   OFFER    — a draft exists holding work the saved record does not. It is
 *              OFFERED, never applied. A draft that appears in the fields
 *              unasked is indistinguishable from the record, and the person
 *              cannot tell what they are about to save over. On a campaign
 *              this surface can no longer edit, the same offer becomes the
 *              precise explanation of why they can only look.
 *   CONFLICT — another device saved newer work than the draft this one tried
 *              to write. BOTH are named; the person picks. Nothing here
 *              decides.
 *   REFUSAL  — the draft broke a rule (too large, unsupported escape, the
 *              per-account draft cap). Autosave is off until the draft
 *              changes, and saying so is the difference between "your work is
 *              safe" and a person believing it while it is not.
 *
 * A fourth, quieter state was computed by the hook and thrown away here until
 * now: the HEALTHY one. `saving` and `lastSavedAt` are the whole reassurance a
 * durable-draft feature exists to give — without them autosave is invisible,
 * and a person who is about to lock their phone mid-sentence has no way to
 * know the work is anywhere but on this screen. Web renders exactly this pair
 * (apps/web/.../campaigns/[id]/page.tsx — "keeping a draft…" / "draft kept
 * <relative>"), so leaving it off here was a divergence, not a decision. It is
 * rendered as a status LINE rather than a bordered Notice: the three states
 * above are things to answer, this one is a thing to glance at.
 *
 * Ported from apps/web/src/components/campaigns/draft-checkpoint-banner.tsx
 * with this app's own primitives: inline token styles like MobileScopeNotice,
 * and ActionButton for the choices so they carry the 44pt hit target and the
 * accessibilityState the rest of the campaign screen uses.
 *
 * NativeWind trap, deliberately avoided: no `style={({pressed}) => …}`
 * anywhere here or in ActionButton. A function-style `style` on Pressable
 * silently drops layout under NativeWind v4 and has broken this app before.
 */
import { Text, View } from "react-native";

import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { isMobileOwnedCheckpoint } from "@/lib/campaignCheckpoint";
import { relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { EditorCheckpointState } from "@/hooks/useEditorCheckpoint";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function DraftCheckpointBanner<T>({
  state,
  canEdit,
}: {
  state: EditorCheckpointState<T>;
  canEdit: boolean;
}) {
  const { t } = useTheme();
  const { offer, conflict, refusal, saving, lastSavedAt } = state;
  if (!offer && !conflict && !refusal && !saving && !lastSavedAt) return null;

  return (
    <View style={{ marginBottom: 12, gap: 12 }}>
      {conflict ? (
        <Notice
          t={t}
          tone={t.warning}
          title="Another device saved a newer draft."
          body={
            conflict.current
              ? `Theirs was kept ${relativeTime(conflict.current.updated_at)}. Nothing has been overwritten — choose which draft to keep.`
              : "We couldn't read the newer draft to show it to you, so nothing on this screen has changed and nothing has been overwritten. Reopen this campaign to load it."
          }
        >
          {conflict.current ? (
            <View style={ROW}>
              <ActionButton
                label="Use the newer draft"
                primary
                onPress={state.useTheirs}
              />
              <ActionButton
                label="Keep what's on this phone"
                onPress={state.keepMine}
              />
            </View>
          ) : null}
        </Notice>
      ) : null}

      {offer ? (
        <Notice
          t={t}
          tone={t.info}
          title="You have an unsaved draft from another device."
          body={
            canEdit
              ? `Last edited ${relativeTime(offer.updated_at)}, after this campaign was last saved. Nothing has been applied yet.`
              : `Last edited ${relativeTime(offer.updated_at)}, after this campaign was last saved. This campaign can no longer be edited, so the draft can only be seen here — reopen it on the device you wrote it on.`
          }
        >
          {canEdit ? (
            <View style={ROW}>
              <ActionButton
                label="Resume this draft"
                primary
                onPress={state.resume}
              />
              {/*
                The label has to match what the button actually does, and that
                depends on what the draft holds. When it carries only the four
                fields this sheet shows, dismissing really does delete it. When
                it also holds an email body written on a laptop, the hook
                deliberately keeps the draft and only clears the offer — so
                promising to "discard" would be describing a deletion that does
                not happen, about content the person was never shown.
              */}
              <ActionButton
                label={
                  isMobileOwnedCheckpoint(offer.content)
                    ? "Discard it and keep the saved version"
                    : "Not now — keep working from what is saved"
                }
                onPress={state.dismiss}
              />
            </View>
          ) : null}
        </Notice>
      ) : null}

      {refusal ? (
        <Notice
          t={t}
          tone={t.danger}
          title="This draft isn't being kept."
          body={`${refusal} Your edits are still on this screen, but they won't survive closing it until you save the campaign.`}
        />
      ) : null}

      {/*
        Suppressed while a conflict or a refusal stands, and not because it
        would be untidy: both of those mean autosave is NOT currently keeping
        this draft, and "Draft kept 5 minutes ago" printed under "this draft
        isn't being kept" is the exact reassurance-without-a-basis the refusal
        state exists to prevent. An unanswered OFFER is different — the draft
        being offered is a different draft from the one this phone is writing,
        and both facts are true at once.
      */}
      {!conflict && !refusal && (saving || lastSavedAt) ? (
        <Text
          {...typeCap("label")}
          accessibilityLiveRegion="polite"
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {saving
            ? "Keeping a draft…"
            : `Draft kept ${relativeTime(lastSavedAt)} — it will still be here on your other devices.`}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * `gap` rather than per-button margins so the row wraps cleanly at the larger
 * OS text sizes, where two of these labels do not fit side by side.
 */
const ROW = {
  flexDirection: "row",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 10,
} as const;

function Notice({
  t,
  tone,
  title,
  body,
  children,
}: {
  t: ThemeTokens;
  tone: string;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <View
      // One accessible node for the sentence, with the choices left as
      // separate focusable buttons after it — a VoiceOver user hears what
      // happened before being offered a decision about it.
      accessible={false}
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: tone,
        borderWidth: 1,
        borderLeftWidth: 3,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <View accessible accessibilityLabel={`${title} ${body}`}>
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontWeight: "700",
            fontFamily: FONT.bold,
          }}
        >
          {title}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            marginTop: 3,
            fontFamily: FONT.regular,
          }}
        >
          {body}
        </Text>
      </View>
      {children}
    </View>
  );
}
