/**
 * CampaignActionRow — every mutating affordance on the campaign detail
 * screen, in one gated place.
 *
 * The gating matrix used to be inline in the route file and keyed only on
 * connectivity, so a read-only viewer saw Send now and Delete at full
 * strength. It now consults campaignAccess() (connectivity + session + role)
 * and, separately, the campaign's own state.
 *
 * "A/B results" is no longer shown on every campaign: it renders only for a
 * genuine A/B parent, because on every other campaign the button led to the
 * "No variants yet" empty state — training operators that it was broken.
 */
import { View } from "react-native";

import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import type { CampaignSheet } from "@/components/campaigns/CampaignDetailModals";
import type { TriggerRef } from "@/hooks/useSheetTriggerRefs";
import type { CampaignLifecycleAction } from "@/hooks/useCampaigns";

function titleCase(word: string): string {
  return `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;
}

const LIFECYCLE_PROGRESS: Record<CampaignLifecycleAction, string> = {
  pause: "Pausing…",
  resume: "Resuming…",
  cancel: "Cancelling…",
};

export interface CampaignActionRowProps {
  canMutate: boolean;
  canAdmin: boolean;
  canEdit: boolean;
  canSchedule: boolean;
  canSend: boolean;
  canTest: boolean;
  canResend: boolean;
  canDelete: boolean;
  canViewAbResults: boolean;
  lifecycleActions: readonly CampaignLifecycleAction[];
  lifecyclePending: boolean;
  lifecycleActionInFlight: CampaignLifecycleAction | null;
  deletePending: boolean;
  resendPending: boolean;
  clonePending: boolean;
  onEditSubject: () => void;
  /** Opens the internal review thread. Read-scope, so never role-gated. */
  onOpenFeedback: () => void;
  /** Admin-only: POST /campaigns/{id}/save-as-template. */
  onSaveAsTemplate: () => void;
  onSchedule: () => void;
  onSendTest: () => void;
  onViewAbResults: () => void;
  onLifecycle: (action: CampaignLifecycleAction) => void;
  onSend: () => void;
  onResend: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /**
   * Binds each button that opens a sheet to a stable ref, so dismissing that
   * sheet hands VoiceOver focus back to the button rather than to the top of
   * the screen. This row is up to eleven buttons wide, which is precisely why
   * it matters here: without it, closing "Send test" cost a blind operator a
   * swipe through the header, both notices, the summary card and half this row
   * before reaching "Schedule".
   *
   * Optional so the row stays renderable on its own; when it is absent the
   * buttons simply carry no ref and focus behaves as the platform decides.
   */
  triggerRef?: ((sheet: CampaignSheet) => TriggerRef) | undefined;
}

export function CampaignActionRow(props: CampaignActionRowProps) {
  // Comments are LIST-read-scope on the gateway, so they are available to every
  // role — including the read-only viewer who was asked to review the draft and
  // whose only job is to say something about it. That makes the row never
  // empty, so the old "nothing to show" early return is gone: it existed to
  // avoid rendering a 12pt-tall empty flex row, and there is now always at
  // least one affordance in it.

  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        marginTop: 12,
      }}
    >
      {props.canEdit ? (
        <ActionButton
          label="Edit"
          onPress={props.onEditSubject}
          buttonRef={props.triggerRef?.("subject")}
          disabled={!props.canMutate}
        />
      ) : null}
      {props.canSchedule ? (
        <ActionButton
          label="Schedule"
          onPress={props.onSchedule}
          buttonRef={props.triggerRef?.("schedule")}
          disabled={!props.canMutate}
        />
      ) : null}
      {props.canTest ? (
        <ActionButton
          label="Send test"
          onPress={props.onSendTest}
          buttonRef={props.triggerRef?.("test")}
          disabled={!props.canMutate}
        />
      ) : null}
      {props.canViewAbResults ? (
        <ActionButton label="A/B results" onPress={props.onViewAbResults} />
      ) : null}
      <ActionButton
        label="Comments"
        onPress={props.onOpenFeedback}
        buttonRef={props.triggerRef?.("feedback")}
      />
      {props.canAdmin ? (
        <ActionButton
          label={props.clonePending ? "Duplicating…" : "Duplicate"}
          onPress={props.onDuplicate}
          disabled={props.clonePending}
        />
      ) : null}
      {/* Admin-scope on the gateway (campaign_to_template.go:69), so it is
          rendered on the same term the server enforces rather than offered
          and then refused. */}
      {props.canAdmin ? (
        <ActionButton
          label="Save as template"
          onPress={props.onSaveAsTemplate}
          buttonRef={props.triggerRef?.("saveTemplate")}
          disabled={!props.canMutate}
        />
      ) : null}
      {props.lifecycleActions.map((action) => (
        <ActionButton
          key={action}
          label={
            props.lifecycleActionInFlight === action
              ? LIFECYCLE_PROGRESS[action]
              : titleCase(action)
          }
          danger={action === "cancel"}
          onPress={() => props.onLifecycle(action)}
          disabled={!props.canMutate || props.lifecyclePending}
        />
      ))}
      {props.canSend ? (
        <ActionButton
          label="Send now"
          primary
          onPress={props.onSend}
          buttonRef={props.triggerRef?.("send")}
          disabled={!props.canMutate}
        />
      ) : null}
      {props.canResend ? (
        <ActionButton
          label={props.resendPending ? "Queuing…" : "Resend to non-openers"}
          onPress={props.onResend}
          buttonRef={props.triggerRef?.("resend")}
          disabled={!props.canMutate || props.resendPending}
        />
      ) : null}
      {props.canDelete ? (
        <ActionButton
          label={props.deletePending ? "Deleting…" : "Delete"}
          danger
          onPress={props.onDelete}
          disabled={!props.canMutate || props.deletePending}
        />
      ) : null}
    </View>
  );
}
