/**
 * VoiceSourcesCard — where the measured profile comes FROM.
 *
 * Before this, the Voice tab was a dead-end read: a measured profile and a
 * rebuild button, with no way to see or change the corpus behind it. An
 * operator who disagreed with the measurement had no move available.
 *
 * Writes are ONLINE-ONLY and the affordances are HIDDEN (not disabled) when
 * they cannot succeed — see api/voiceSources.ts. Deleting a source is
 * irreversible, so it goes through ConfirmSheet rather than the kit's
 * toast-with-undo default.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { AddVoiceSourceSheet } from "@/components/voice/AddVoiceSourceSheet";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  voiceSourceDetail,
  voiceSourceLabel,
  type VoiceSourceWire,
} from "@/lib/voiceSources";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  useCreateVoiceSource,
  useDeleteVoiceSource,
  useVoiceSourceIngest,
  useVoiceSources,
} from "@/hooks/useVoiceSources";

export function VoiceSourcesCard({
  canWrite,
  offline,
}: {
  /** editor+ on a live session — every write here is write:campaigns. */
  canWrite: boolean;
  offline: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const query = useVoiceSources();
  const create = useCreateVoiceSource();
  const remove = useDeleteVoiceSource();
  const ingest = useVoiceSourceIngest();
  const [sheetOpen, setSheetOpen] = useState(false);

  const sources = Array.isArray(query.data) ? query.data : [];
  const showWrites = canWrite && !offline;

  const onDelete = useCallback(
    (source: VoiceSourceWire) => {
      const label = voiceSourceLabel(source.type);
      void (async () => {
        const ok = await confirm({
          title: `Remove ${label}?`,
          message:
            "The source stops feeding your voice profile. Text already measured stays in the current profile until it is rebuilt.",
          confirmLabel: "Remove",
          destructive: true,
        });
        if (!ok) return;
        try {
          await remove.mutateAsync(source.id);
          haptics.success();
          toast({ kind: "success", message: `Removed ${label}.` });
        } catch (err) {
          toast({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : "Couldn't remove that source.",
          });
        }
      })();
    },
    [confirm, remove, toast],
  );

  const onAdd = useCallback(
    (body: Parameters<typeof create.mutateAsync>[0]) => {
      void (async () => {
        try {
          await create.mutateAsync(body);
          setSheetOpen(false);
          haptics.success();
          toast({
            kind: "success",
            message: "Source added. Run it to read its content.",
          });
        } catch (err) {
          toast({
            kind: "error",
            message:
              err instanceof Error ? err.message : "Couldn't add that source.",
          });
        }
      })();
    },
    [create, toast],
  );

  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontWeight: "500",
            fontFamily: FONT.medium,
            flex: 1,
          }}
        >
          Sources
        </Text>
        {showWrites ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add a voice source"
            hitSlop={8}
            onPress={() => {
              haptics.tap();
              setSheetOpen(true);
            }}
            style={{
              minHeight: 44,
              minWidth: 44,
              paddingHorizontal: 12,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Add
            </Text>
          </Pressable>
        ) : null}
      </View>

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        What Moosewave reads to measure how you write.
      </Text>

      {query.isLoading ? (
        <SkeletonList rows={2} lines={2} />
      ) : query.isError ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : sources.length === 0 ? (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {showWrites
            ? "No sources yet. Add a feed or paste some writing to give the profile something to measure."
            : "No sources yet. Someone with edit access can add a feed or paste some writing."}
        </Text>
      ) : (
        <View style={{ gap: 8 }}>
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              showWrites={showWrites}
              busy={ingest.busySourceId === source.id}
              runMessage={
                ingest.state?.sourceId === source.id
                  ? ingest.state.message
                  : null
              }
              disabled={ingest.busySourceId !== null}
              onRun={() => {
                haptics.tap();
                ingest.run(source.id);
              }}
              onDelete={() => onDelete(source)}
            />
          ))}
        </View>
      )}

      <AddVoiceSourceSheet
        visible={sheetOpen}
        saving={create.isPending}
        onCancel={() => setSheetOpen(false)}
        onSubmit={onAdd}
      />
    </Card>
  );
}

function SourceRow({
  source,
  showWrites,
  busy,
  runMessage,
  disabled,
  onRun,
  onDelete,
}: {
  source: VoiceSourceWire;
  showWrites: boolean;
  busy: boolean;
  runMessage: string | null;
  disabled: boolean;
  onRun: () => void;
  onDelete: () => void;
}) {
  const { t } = useTheme();
  const label = voiceSourceLabel(source.type);
  const detail = voiceSourceDetail(source);
  const ingested = source.last_ingested_at
    ? relativeTime(source.last_ingested_at)
    : null;
  return (
    <View
      style={{
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 6,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${label}. ${detail}.${ingested ? ` Last read ${ingested}.` : " Never read."}`}
        style={{ gap: 2 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            {...typeCap("callout")}
            numberOfLines={1}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontFamily: FONT.medium,
              flex: 1,
            }}
          >
            {label}
          </Text>
          {ingested ? null : <Pill label="Never read" tone="warning" />}
        </View>
        <Text
          {...typeCap("label")}
          numberOfLines={2}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {detail}
          {ingested ? ` · read ${ingested}` : ""}
        </Text>
      </View>

      {runMessage ? (
        <Text
          {...typeCap("label")}
          accessibilityRole="alert"
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {runMessage}
        </Text>
      ) : null}

      {showWrites ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <RowAction
            label={busy ? "Running…" : "Run now"}
            accessibilityLabel={`Read ${label} again now`}
            disabled={disabled}
            onPress={onRun}
          />
          <RowAction
            label="Remove"
            accessibilityLabel={`Remove ${label} from the voice corpus`}
            disabled={busy}
            danger
            onPress={onDelete}
          />
        </View>
      ) : null}
    </View>
  );
}

function RowAction({
  label,
  accessibilityLabel,
  disabled,
  danger,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={{
        minHeight: 44,
        paddingHorizontal: 12,
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: danger ? t.danger : t.border,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: danger ? t.danger : t.fg,
          ...typeStyle("bodySmall"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
