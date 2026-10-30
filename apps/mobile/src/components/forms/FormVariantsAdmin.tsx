/**
 * FormVariantsAdmin — the admin half of the display-variants section, split
 * out of FormVariantsSection at its source budget.
 *
 * Everything here is ONLINE-ONLY and ADMIN-floor (see FormVariantsSection's
 * header for the status-machine facts: `exploring ↔ paused` is the only legal
 * toggle, promoted is terminal, and promotion itself is the SERVER's decision
 * via evaluate).
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import {
  useCreateFormVariant,
  useDeleteFormVariant,
  useEvaluateFormVariants,
  useUpdateFormVariant,
} from "@/hooks/useFormOps";
import { FONT } from "@/lib/fonts";
import type { FormVariantRow } from "@/lib/formVariants";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface ComposerState {
  /** null = creating; otherwise the variant being edited. */
  variantId: string | null;
  label: string;
  trafficPct: string;
}

/** The mutations plus their confirm/toast choreography, in one bundle. */
export function useVariantAdminOps(formId: string) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const createVariant = useCreateFormVariant();
  const updateVariant = useUpdateFormVariant();
  const deleteVariant = useDeleteFormVariant();
  const evaluate = useEvaluateFormVariants();
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const busy =
    createVariant.isPending ||
    updateVariant.isPending ||
    deleteVariant.isPending ||
    evaluate.isPending;

  const fail = (error: unknown, fallback: string) => {
    haptics.error();
    toast({
      kind: "error",
      message:
        error instanceof Error && error.message ? error.message : fallback,
    });
  };

  const onToggle = async (row: FormVariantRow) => {
    if (busy) return;
    const pausing = row.status === "exploring";
    haptics.impact();
    try {
      await updateVariant.mutateAsync({
        formId,
        variantId: row.id,
        patch: { status: pausing ? "paused" : "exploring" },
      });
      haptics.success();
      toast({
        kind: "success",
        message: pausing
          ? `${row.label} paused — it stops receiving traffic.`
          : `${row.label} is exploring again.`,
      });
    } catch (error) {
      fail(error, "Couldn't change that variant.");
    }
  };

  const onRemove = async (row: FormVariantRow) => {
    if (busy) return;
    const ok = await confirm({
      title: `Remove ${row.label}?`,
      message:
        "The variant and its collected results are removed, and visitor traffic re-splits across the remaining arms.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    haptics.impact();
    try {
      await deleteVariant.mutateAsync({ formId, variantId: row.id });
      haptics.success();
      toast({ kind: "success", message: `${row.label} removed.` });
    } catch (error) {
      fail(error, "Couldn't remove that variant.");
    }
  };

  const onEvaluate = async () => {
    if (busy) return;
    haptics.impact();
    try {
      const result = await evaluate.mutateAsync(formId);
      haptics.success();
      const promoted =
        result?.decision?.promoted_variant_id ??
        result?.decision?.promotedVariantId;
      toast({
        kind: "success",
        message: promoted
          ? "The server promoted a winner and re-weighted traffic."
          : "Evaluated — no winner yet, traffic re-weighted toward the leaders.",
      });
    } catch (error) {
      fail(error, "Couldn't evaluate the variants.");
    }
  };

  const onComposerSave = async () => {
    if (!composer || busy) return;
    const label = composer.label.trim();
    if (label === "") {
      toast({ kind: "error", message: "Give the variant a label." });
      return;
    }
    const pctText = composer.trafficPct.trim();
    let trafficPct: number | undefined;
    if (pctText !== "") {
      const parsed = Number(pctText);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        toast({ kind: "error", message: "Traffic must be 0–100 (percent)." });
        return;
      }
      trafficPct = Math.trunc(parsed);
    }
    haptics.impact();
    try {
      if (composer.variantId === null) {
        await createVariant.mutateAsync({
          formId,
          label,
          ...(trafficPct === undefined ? {} : { trafficPct }),
        });
        toast({ kind: "success", message: `${label} added.` });
      } else {
        await updateVariant.mutateAsync({
          formId,
          variantId: composer.variantId,
          patch: {
            label,
            ...(trafficPct === undefined ? {} : { trafficPct }),
          },
        });
        toast({ kind: "success", message: `${label} updated.` });
      }
      haptics.success();
      setComposer(null);
    } catch (error) {
      fail(error, "Couldn't save the variant.");
    }
  };

  return {
    busy,
    composer,
    setComposer,
    onToggle,
    onRemove,
    onEvaluate,
    onComposerSave,
    evaluating: evaluate.isPending,
  };
}

/** The pause/edit/remove row under one non-promoted variant. */
export function VariantAdminBar({
  row,
  busy,
  onToggle,
  onEdit,
  onRemove,
}: {
  row: FormVariantRow;
  busy: boolean;
  onToggle: (row: FormVariantRow) => void;
  onEdit: (row: FormVariantRow) => void;
  onRemove: (row: FormVariantRow) => void;
}) {
  const togglable = row.status === "exploring" || row.status === "paused";
  return (
    <View style={{ flexDirection: "row", gap: 16 }}>
      {togglable ? (
        <VariantTextButton
          label={row.status === "exploring" ? "Pause" : "Resume"}
          disabled={busy}
          onPress={() => onToggle(row)}
        />
      ) : null}
      <VariantTextButton
        label="Edit"
        disabled={busy}
        onPress={() => onEdit(row)}
      />
      <VariantTextButton
        label="Remove"
        danger
        disabled={busy}
        onPress={() => onRemove(row)}
      />
    </View>
  );
}

/** The two-field add/edit composer. */
export function VariantComposer({
  composer,
  busy,
  onChange,
  onSave,
}: {
  composer: ComposerState;
  busy: boolean;
  onChange: (next: ComposerState) => void;
  onSave: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        value={composer.label}
        onChangeText={(label) => onChange({ ...composer, label })}
        placeholder="Variant label"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Variant label"
        returnKeyType="done"
        maxLength={64}
        {...typeCap("body")}
        style={composerInput(t.fg, t.surface, t.borderSubtle)}
      />
      <TextInput
        value={composer.trafficPct}
        onChangeText={(trafficPct) => onChange({ ...composer, trafficPct })}
        placeholder="Traffic % (blank = even split)"
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel="Traffic percentage, optional"
        returnKeyType="done"
        keyboardType="number-pad"
        maxLength={3}
        {...typeCap("body")}
        style={composerInput(t.fg, t.surface, t.borderSubtle)}
      />
      <VariantTextButton
        label={
          busy
            ? "Saving…"
            : composer.variantId === null
              ? "Add variant"
              : "Save changes"
        }
        disabled={busy}
        onPress={onSave}
      />
    </View>
  );
}

export function VariantTextButton({
  label,
  onPress,
  disabled,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{ minHeight: 44, justifyContent: "center" }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: disabled ? t.fgSubtle : danger ? t.danger : t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function composerInput(color: string, background: string, border: string) {
  return {
    color,
    backgroundColor: background,
    borderColor: border,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: fontSizeFor("body"),
    fontFamily: FONT.regular,
    minHeight: 44,
  } as const;
}
