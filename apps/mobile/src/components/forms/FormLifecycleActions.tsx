/**
 * FormLifecycleActions — the publish / move-to-draft / archive verbs, and the
 * admin danger zone, for one form.
 *
 * Two renderings of the same verb table (lib/formLifecycle):
 *   - `FormLifecycleCard` sits on the form detail screen;
 *   - `FormQuickActionsSheet` opens from a LONG-PRESS on a list row, so a
 *     misbehaving live form can be pulled without navigating into it.
 *
 * Every verb passes through ConfirmSheet — each one changes what the public
 * internet is served — and the runner refuses OFFLINE taps with the policy
 * sentence from lib/formLifecycle rather than queueing (the queue-safety
 * module refuses status bodies by rule).
 *
 * DELETE is the admin-only danger zone: a HARD server delete that cascades
 * through the form's submissions, so it takes the typed-phrase confirm — the
 * treatment this codebase reserves for irreversible, high-blast-radius verbs.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useDeleteForm, useUpdateFormStatus } from "@/hooks/useFormOps";
import {
  FORM_ARCHIVED_TERMINAL_NOTE,
  FORM_LIFECYCLE_OFFLINE_MESSAGE,
  formLifecycleActions,
  type FormLifecycleAction,
} from "@/lib/formLifecycle";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

interface LifecycleTarget {
  id: string;
  name?: string | undefined;
  slug?: string | undefined;
  status?: string | undefined;
}

function displayName(form: LifecycleTarget): string {
  return form.name?.trim() || form.slug?.trim() || "this form";
}

/** Confirm → PATCH → toast. Shared by the card and the sheet. */
export function useFormLifecycleRunner(onDone?: () => void) {
  const confirm = useConfirm();
  const { toast } = useToast();
  const online = useIsOnline();
  const update = useUpdateFormStatus();

  const run = useCallback(
    async (form: LifecycleTarget, action: FormLifecycleAction) => {
      if (update.isPending) return;
      if (!online) {
        haptics.error();
        toast({ kind: "error", message: FORM_LIFECYCLE_OFFLINE_MESSAGE });
        return;
      }
      const ok = await confirm({
        title: action.confirmTitle,
        message: action.confirmMessage,
        confirmLabel: action.label,
        destructive: action.destructive,
      });
      if (!ok) return;
      haptics.impact();
      try {
        await update.mutateAsync({ id: form.id, status: action.target });
        haptics.success();
        toast({ kind: "success", message: action.successMessage });
        onDone?.();
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : `${action.label} failed. Please try again.`,
        });
      }
    },
    [confirm, online, onDone, toast, update],
  );

  return { run, pending: update.isPending };
}

export interface FormLifecycleCardProps {
  form: LifecycleTarget;
  /** Editor floor for the status verbs; computed by the route. */
  canLifecycle: boolean;
  /** Admin floor for delete; computed by the route. */
  canDelete: boolean;
  /** Called after a successful hard delete, to leave the dead screen. */
  onDeleted: () => void;
}

export function FormLifecycleCard(props: FormLifecycleCardProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const online = useIsOnline();
  const { run, pending } = useFormLifecycleRunner();
  const del = useDeleteForm();

  const actions = formLifecycleActions(props.form.status, displayName(props.form));
  const archivedTerminal =
    (props.form.status ?? "").trim().toLowerCase() === "archived";

  const onDelete = useCallback(async () => {
    if (del.isPending) return;
    if (!online) {
      haptics.error();
      toast({
        kind: "error",
        message: "Deleting a form needs a connection — it is never queued.",
      });
      return;
    }
    const phrase = props.form.slug?.trim() || props.form.name?.trim() || "";
    const ok = await confirm({
      title: `Delete ${displayName(props.form)}?`,
      message:
        "This is a HARD delete on the server: the form and every submission it captured are removed together, and there is no undelete.",
      confirmLabel: "Delete form",
      destructive: true,
      ...(phrase ? { confirmPhrase: phrase } : {}),
      consequence: "The form's submission records are deleted with it.",
    });
    if (!ok) return;
    haptics.impact();
    try {
      await del.mutateAsync(props.form.id);
      haptics.success();
      toast({
        kind: "success",
        message: `${displayName(props.form)} deleted.`,
      });
      props.onDeleted();
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Delete failed. Please try again.",
      });
    }
  }, [confirm, del, online, props, toast]);

  if (!props.canLifecycle && !props.canDelete) return null;

  return (
    <Card style={{ gap: 10 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Manage
      </Text>
      {props.canLifecycle && actions.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {actions.map((action) => (
            <VerbButton
              key={action.target}
              label={action.label}
              destructive={action.destructive}
              disabled={pending}
              onPress={() => void run(props.form, action)}
            />
          ))}
        </View>
      ) : null}
      {props.canLifecycle && archivedTerminal ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {FORM_ARCHIVED_TERMINAL_NOTE}
        </Text>
      ) : null}
      {props.canDelete ? (
        <Pressable
          onPress={() => void onDelete()}
          disabled={del.isPending}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${displayName(props.form)} and all of its submissions`}
          accessibilityState={{ disabled: del.isPending }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: del.isPending ? t.fgSubtle : t.danger,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {del.isPending ? "Deleting…" : "Delete form…"}
          </Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

export interface FormQuickActionsSheetProps {
  /** The long-pressed row, or null when closed. */
  form: LifecycleTarget | null;
  onClose: () => void;
}

/** The long-press sheet: the same verb table, one tap from the list. */
export function FormQuickActionsSheet(props: FormQuickActionsSheetProps) {
  const { t } = useTheme();
  const { run, pending } = useFormLifecycleRunner(props.onClose);
  const form = props.form;
  const actions = form
    ? formLifecycleActions(form.status, displayName(form))
    : [];
  return (
    <ReducedMotionModal
      visible={form !== null}
      animationType="fade"
      transparent
      onRequestClose={props.onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss form actions"
        onPress={props.onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.45)",
          justifyContent: "flex-end",
        }}
      >
        <View
          // Swallow taps inside the panel so only the scrim dismisses — a
          // responder-claiming View, not a nested Pressable (the interactive-
          // semantics sweep forbids button-in-button).
          onStartShouldSetResponder={() => true}
          style={{
            backgroundColor: t.surface,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            padding: 16,
            paddingBottom: 28,
            gap: 8,
          }}
        >
          <Text
            accessibilityRole="header"
            {...typeCap("callout")}
            numberOfLines={2}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {form ? displayName(form) : ""}
          </Text>
          {actions.length === 0 ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              {FORM_ARCHIVED_TERMINAL_NOTE}
            </Text>
          ) : (
            actions.map((action) => (
              <VerbButton
                key={action.target}
                label={action.label}
                destructive={action.destructive}
                disabled={pending}
                onPress={() => {
                  if (form) void run(form, action);
                }}
              />
            ))
          )}
        </View>
      </Pressable>
    </ReducedMotionModal>
  );
}

function VerbButton({
  label,
  destructive,
  disabled,
  onPress,
}: {
  label: string;
  destructive: boolean;
  disabled: boolean;
  onPress: () => void;
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
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        minHeight: 44,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: destructive ? t.danger : t.border,
        backgroundColor: t.surface,
        opacity: disabled ? 0.45 : 1,
        paddingHorizontal: 12,
      }}
    >
      <Text
        {...typeCap("control")}
        numberOfLines={1}
        style={{
          color: destructive ? t.danger : t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
