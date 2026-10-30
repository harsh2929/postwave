/**
 * VoiceLabelsSection — submit-a-label form + recent-labels list.
 *
 * Five-axis tone calibration (humor / formality / optimism / directness /
 * warmth), values clamped to [0, 1]. The form itself lives in ./VoiceLabelForm.
 *
 * This section used to be the one place in the app that opted out of the whole
 * client substrate, and every one of those opt-outs was a real defect:
 *
 *   - It fetched with `useState` + `useEffect` instead of TanStack Query, so
 *     the list was not identity-scoped: state survived a workspace switch on a
 *     shared device and every mount refetched from scratch.
 *   - It ignored the ONLINE GATE, so it issued requests on a cached session the
 *     app had not yet re-validated — the one screen able to punch through the
 *     session-validation contract.
 *   - It dropped a submitted label whenever the request failed, on the device
 *     most likely to lose connectivity. The create is now queued through the
 *     generic offline entity write, so a label typed in a tunnel lands on
 *     reconnect. DELETE is deliberately NOT queued (offlineQueueSafety denies
 *     every DELETE): a destructive write arriving an hour late is unrecoverable.
 *   - It used modal Alerts for every outcome, including success, against the
 *     app's Toast doctrine.
 *   - It hard-capped the list at 25 rows and threw away the server's `total`,
 *     so a workspace with 300 labels saw 25 and was told nothing about the rest.
 */
import { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteVoiceLabel,
  listVoiceLabels,
  type VoiceAxis,
  type VoiceLabel,
} from "@/api/voiceLabels";
import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import {
  FieldLabel,
  SectionMeta,
  VoiceLabelForm,
} from "@/components/settings/VoiceLabelForm";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { executeEntityWrite } from "@/lib/offlineEntityWrite";
import { OFFLINE_MUTATION_KEYS } from "@/lib/offlineMutationContract";
import { newOfflineMutationMetadata } from "@/lib/offlineMutations";
import { offlineSafeMutationMeta } from "@/lib/queryClient";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  VOICE_LABEL_PAGE_SIZE,
  normalizeVoiceLabelSample,
  parseVoiceLabelValue,
  voiceLabelPageSummary,
  voiceLabelsUnavailable,
} from "@/lib/voiceLabelForm";

export function VoiceLabelsSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();

  const [sample, setSample] = useState("");
  const [axis, setAxis] = useState<VoiceAxis>("humor");
  const [value, setValue] = useState("0.5");
  const [size, setSize] = useState(VOICE_LABEL_PAGE_SIZE);

  // Tenant-scoped like every other query in the app: a row must never survive
  // a workspace switch on a shared device.
  const labels = useQuery({
    queryKey: ["voice-labels", gate.tenantId, size],
    queryFn: () => listVoiceLabels({ size }),
    enabled: gate.enabled && Boolean(gate.tenantId),
  });

  // Array.isArray, not `?? []`: the envelope is handed back unparsed, so a
  // gateway (or a restored cache) that answers `items: {}` would reach .map as
  // a truthy non-iterable and take the whole Settings screen down.
  const raw = labels.data?.data?.items;
  const items = Array.isArray(raw) ? raw : [];
  const page = voiceLabelPageSummary(items.length, labels.data?.data?.total);
  // `listVoiceLabels` RESOLVES the mobile envelope instead of throwing, so
  // `labels.isError` is structurally unreachable here: a 500, a 403 and a
  // dropped connection all arrive as `data.error` with no items. Rendering
  // that as "No labels submitted yet" tells the operator the trainer corpus is
  // empty when the read merely failed — the one lie this section can tell.
  const wireError = labels.data?.error ?? null;
  const unavailable = voiceLabelsUnavailable(wireError?.status);
  const loadFailed = !unavailable && (labels.isError || wireError !== null);
  // Offline is a third answer, not the empty one. The gate DISABLES the query,
  // so it never loads and never errors: without this branch an operator in a
  // tunnel is told the workspace has never labelled anything.
  const offline = !gate.enabled && labels.data === undefined;

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["voice-labels"] });
  }, [qc]);
  const failed = useCallback(
    (err: unknown, fallback: string) => {
      toast({
        kind: "error",
        message: err instanceof Error && err.message ? err.message : fallback,
      });
    },
    [toast],
  );

  const create = useMutation({
    mutationKey: OFFLINE_MUTATION_KEYS.entityWrite,
    meta: offlineSafeMutationMeta,
    mutationFn: executeEntityWrite,
    onSuccess: () => {
      setSample("");
      setValue("0.5");
      invalidate();
      toast({ kind: "success", message: "Label recorded." });
    },
    onError: (err: unknown) => failed(err, "Couldn't submit that label."),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await deleteVoiceLabel(id);
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    onSuccess: () => {
      invalidate();
      toast({ kind: "success", message: "Label deleted." });
    },
    onError: (err: unknown) => failed(err, "Couldn't delete that label."),
  });

  const submit = useCallback(() => {
    const text = normalizeVoiceLabelSample(sample);
    if (!text) {
      toast({ kind: "warning", message: "Enter the snippet you want to label." });
      return;
    }
    const parsed = parseVoiceLabelValue(value);
    if (!parsed.ok) {
      toast({ kind: "warning", message: parsed.message });
      return;
    }
    create.mutate({
      ...newOfflineMutationMetadata(),
      method: "POST",
      path: "/api/v1/voice/labels",
      body: { sample_text: text, axis, value: parsed.value },
      invalidateRoots: ["voice-labels"],
      label: "Voice label",
    });
  }, [axis, create, sample, toast, value]);

  const onDelete = useCallback(
    (label: VoiceLabel) => {
      void (async () => {
        // Irreversible AND not queueable, so it earns a confirm rather than
        // the undo toast a reversible action would get.
        const ok = await confirm({
          title: "Delete this label?",
          message: "It is removed from the trainer corpus immediately.",
          confirmLabel: "Delete",
          destructive: true,
        });
        if (ok) remove.mutate(label.id);
      })();
    },
    [confirm, remove],
  );

  if (unavailable) {
    return (
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
        }}
      >
        <SectionMeta>Voice labels unavailable on this deployment.</SectionMeta>
      </View>
    );
  }

  return (
    // This self-contained form sits low in the host Settings ScrollView, so a
    // KeyboardAvoidingView lifts the inputs and Submit above the keyboard on
    // iOS. The host already sets keyboardShouldPersistTaps="handled".
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ gap: 12 }}
    >
      <VoiceLabelForm
        sample={sample}
        onSample={setSample}
        axis={axis}
        onAxis={setAxis}
        value={value}
        onValue={setValue}
        onSubmit={submit}
        submitting={create.isPending}
      />

      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8 }}>
        <FieldLabel>Recent labels</FieldLabel>
        {items.length > 0 ? (
          <Text
            {...typeCap("badgeSmall")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("badgeSmall"),
              marginStart: "auto",
              fontFamily: FONT.regular,
            }}
          >
            {page.caption}
          </Text>
        ) : null}
      </View>

      {labels.isLoading ? <SkeletonList rows={3} lines={2} /> : null}

      {!labels.isLoading && loadFailed ? (
        <ErrorState
          compact
          error={wireError ?? labels.error}
          onRetry={() => void labels.refetch()}
        />
      ) : null}

      {!labels.isLoading && !loadFailed && offline ? (
        <ErrorState
          compact
          message="You're offline, so the recent labels can't be loaded. Reconnect and pull to refresh."
        />
      ) : null}

      {!labels.isLoading && !loadFailed && !offline && items.length === 0 ? (
        <SectionMeta>
          No labels submitted yet. The trainer projects each label onto the
          five-axis tone space.
        </SectionMeta>
      ) : null}

      <View style={{ gap: 8 }}>
        {items.map((l) => (
          <LabelRow key={l.id} label={l} onDelete={onDelete} />
        ))}
      </View>

      {page.hasMore ? (
        <Pressable
          onPress={() => setSize((n) => n + VOICE_LABEL_PAGE_SIZE)}
          accessibilityRole="button"
          accessibilityLabel={`Load more labels. Showing ${page.caption}.`}
          style={{
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.bgSubtle,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.fg,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {labels.isFetching ? "Loading…" : "Load more"}
          </Text>
        </Pressable>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function LabelRow({
  label,
  onDelete,
}: {
  label: VoiceLabel;
  onDelete: (label: VoiceLabel) => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Text
          {...typeCap("numeric")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("numeric"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          {label.axis} · {label.value.toFixed(2)}
          {label.created_at ? ` · ${relativeTime(label.created_at)}` : ""}
        </Text>
        <Pressable
          onPress={() => onDelete(label)}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${label.axis} voice label`}
          hitSlop={12}
          style={{
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: "transparent",
            minWidth: 44,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            // Decorative: a "×" standing in for a close icon inside a fixed
            // hit target. The Pressable above carries the spoken label, so
            // scaling this glyph would only break the button's geometry.
            allowFontScaling={false}
            style={{ color: t.danger, fontSize: 18, fontFamily: FONT.regular }}
          >
            ×
          </Text>
        </Pressable>
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
        numberOfLines={2}
        selectable
      >
        {label.sample_text}
      </Text>
    </View>
  );
}
