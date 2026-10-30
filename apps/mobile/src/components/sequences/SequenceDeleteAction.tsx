/**
 * SequenceDeleteAction — the header affordance for deleting a sequence.
 *
 * Lives beside the share action rather than inside the detail screen because
 * `sequences/[id].tsx` is already at its source budget, and because the list
 * row's swipe action needs the same confirm + toast behaviour: both call sites
 * share `useSequenceDeleteFlow` below.
 *
 * A pre-confirm, not a toast-with-undo. The kit's default for a destructive
 * action is the undo pattern — correct whenever the mutation is reversible.
 * `DELETE /api/v1/voice/sequences/{id}` has no inverse, so the cost has to be
 * paid before the action, with the sequence's own name typed.
 */
import { useCallback, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useDeleteSequence } from "@/hooks/useSequences";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canDeleteSequence, sequenceDeleteConfirm } from "@/lib/sequenceDelete";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface SequenceDeleteTarget {
  id: string;
  name?: string | undefined;
  stepCount?: number | undefined;
  /** Known version, when the caller holds one. The list does not. */
  version?: number | undefined;
}

/**
 * Confirm → delete → toast. Returns a function that resolves true when the
 * row was actually removed, so a caller can navigate away only on success.
 */
export function useSequenceDeleteFlow(): {
  run: (target: SequenceDeleteTarget) => Promise<boolean>;
  pending: boolean;
} {
  const confirm = useConfirm();
  const { toast } = useToast();
  const remove = useDeleteSequence();

  const run = useCallback(
    async (target: SequenceDeleteTarget): Promise<boolean> => {
      const ok = await confirm(
        sequenceDeleteConfirm({
          name: target.name,
          stepCount: target.stepCount,
        }),
      );
      if (!ok) return false;
      try {
        await remove.mutateAsync({
          id: target.id,
          ...(target.version !== undefined ? { version: target.version } : {}),
          ...(target.name !== undefined ? { name: target.name } : {}),
        });
        haptics.success();
        toast({
          kind: "success",
          message: target.name
            ? `Deleted “${target.name}”.`
            : "Sequence deleted.",
        });
        return true;
      } catch (err) {
        toast({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Couldn't delete this sequence.",
        });
        return false;
      }
    },
    [confirm, remove, toast],
  );

  return { run, pending: remove.isPending };
}

/**
 * The detail header's whole right slot: share, plus delete when it can
 * actually succeed.
 *
 * The gating lives here rather than in the screen so `sequences/[id].tsx`
 * keeps to its shipped job — deciding which of the five read states to render
 * — instead of also carrying the delete preconditions.
 */
export function SequenceDetailActions({
  id,
  name,
  stepCount,
  version,
  online,
  canWrite,
  hasDetail,
  fromSnapshot,
  onDeleted,
  share,
}: {
  id: string | undefined;
  name: string;
  stepCount: number;
  version: number | null;
  online: boolean;
  canWrite: boolean;
  hasDetail: boolean;
  /** A stored projection carries no version, so it can never delete. */
  fromSnapshot: boolean;
  onDeleted: () => void;
  share: ReactNode;
}) {
  const showDelete =
    hasDetail &&
    !fromSnapshot &&
    Boolean(id) &&
    canDeleteSequence({ online, version, canWrite });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {share}
      {showDelete ? (
        <SequenceDeleteAction
          target={{
            id: id ?? "",
            ...(name ? { name } : {}),
            stepCount,
            ...(version !== null ? { version } : {}),
          }}
          onDeleted={onDeleted}
        />
      ) : null}
    </View>
  );
}

export function SequenceDeleteAction({
  target,
  onDeleted,
}: {
  target: SequenceDeleteTarget;
  onDeleted: () => void;
}) {
  const { t } = useTheme();
  const { run, pending } = useSequenceDeleteFlow();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        target.name ? `Delete sequence ${target.name}` : "Delete this sequence"
      }
      accessibilityHint="Asks you to type the sequence name before deleting it permanently."
      accessibilityState={{ disabled: pending, busy: pending }}
      disabled={pending}
      hitSlop={8}
      onPress={() => {
        void run(target).then((deleted) => {
          if (deleted) onDeleted();
        });
      }}
      style={{
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        opacity: pending ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: t.danger,
          ...typeStyle("control"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {pending ? "Deleting…" : "Delete"}
      </Text>
    </Pressable>
  );
}
