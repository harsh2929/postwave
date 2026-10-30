/**
 * BrandVoiceCard — the AUTHORED half of the Voice tab.
 *
 * The Voice tab used to show only the MEASURED profile, which describes how
 * the workspace already writes. It never showed the descriptors, writing rules
 * and sample snippets an operator TYPED — the instructions the AI is supposed
 * to obey. An operator could write "never use exclamation marks" on desktop
 * and mobile would keep reporting their voice as "playful, warm" with no hint
 * that a rule existed at all.
 *
 * The distinction is carried in the copy, not just the layout, because the two
 * rows disagree in the normal case: measurement is descriptive, authoring is
 * prescriptive, and an operator needs to know which one they are looking at
 * before deciding anything.
 *
 * Editing is admin-only (PUT is `apikeys.ScopeAdmin`), and the PUT is a full
 * replace — see api/brandVoice.ts. Non-admins get the read, with no button
 * that can only ever 403.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { SkeletonCard } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { BrandVoiceEditor } from "@/components/voice/BrandVoiceEditor";
import { FONT } from "@/lib/fonts";
import { plural, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import type { BrandVoiceProfile } from "@/lib/brandVoice";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  useBrandVoiceProfile,
  useSaveBrandVoiceProfile,
} from "@/hooks/useVoice";

export function BrandVoiceCard({
  canEdit,
  offline,
}: {
  /** True only for an admin on a live session — PUT is admin-scoped. */
  canEdit: boolean;
  /** Online gate closed: render what we have, offer nothing that writes. */
  offline: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const query = useBrandVoiceProfile();
  const save = useSaveBrandVoiceProfile();
  const [editorOpen, setEditorOpen] = useState(false);

  const profile = query.data ?? null;
  const showEdit = canEdit && !offline && !query.isLoading && !query.isError;

  const onSave = useCallback(
    (draft: { descriptors: string[]; writingRules: string[] }) => {
      save.mutate(
        {
          descriptors: draft.descriptors,
          writingRules: draft.writingRules,
          // Full replace: snippets are not editable on mobile, so they are
          // sent back exactly as read. Omitting them would delete them.
          sampleSnippets: profile?.sampleSnippets ?? [],
        },
        {
          onSuccess: () => {
            setEditorOpen(false);
            haptics.success();
            toast({ kind: "success", message: "Authored brand voice saved." });
          },
          onError: (err: unknown) => {
            toast({
              kind: "error",
              message:
                err instanceof Error
                  ? err.message
                  : "Couldn't save the authored brand voice.",
            });
          },
        },
      );
    },
    [profile, save, toast],
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
          Authored brand voice
        </Text>
        {showEdit ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit the authored brand voice"
            onPress={() => {
              haptics.tap();
              setEditorOpen(true);
            }}
            hitSlop={8}
            style={{
              minHeight: 44,
              minWidth: 44,
              paddingHorizontal: 12,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
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
              Edit
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
        What you told Moosewave to do. The fingerprint below is the opposite
        direction — what Moosewave measured you already do.
      </Text>

      {query.isLoading ? (
        <SkeletonCard lines={3} />
      ) : query.isError ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : !profile || profile.empty ? (
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {canEdit
            ? "Nothing authored yet. Add descriptors and writing rules to steer every AI draft."
            : "Nothing authored yet. An admin can add descriptors and writing rules to steer every AI draft."}
        </Text>
      ) : (
        <AuthoredBody profile={profile} />
      )}

      <BrandVoiceEditor
        visible={editorOpen}
        descriptors={profile?.descriptors ?? []}
        writingRules={profile?.writingRules ?? []}
        snippetCount={profile?.sampleSnippets.length ?? 0}
        saving={save.isPending}
        onCancel={() => setEditorOpen(false)}
        onSave={onSave}
      />
    </Card>
  );
}

function AuthoredBody({ profile }: { profile: BrandVoiceProfile }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 12 }}>
      {profile.descriptors.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SubLabel>Descriptors</SubLabel>
          <View
            accessible
            accessibilityLabel={`${plural(profile.descriptors.length, "descriptor")}: ${profile.descriptors.join(", ")}`}
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}
          >
            {profile.descriptors.map((d) => (
              <Pill key={d} label={d} tone="accent" />
            ))}
          </View>
        </View>
      ) : null}

      {profile.writingRules.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SubLabel>Writing rules</SubLabel>
          {profile.writingRules.map((rule, i) => (
            <View
              key={`${i}-${rule.slice(0, 24)}`}
              accessible
              accessibilityLabel={`Rule ${i + 1} of ${profile.writingRules.length}. ${rule}`}
              style={{ flexDirection: "row", gap: 8 }}
            >
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                  minWidth: 18,
                }}
              >
                {i + 1}.
              </Text>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                  flex: 1,
                }}
              >
                {rule}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {profile.sampleSnippets.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SubLabel>Sample snippets</SubLabel>
          <Text
            {...typeCap("bodySmall")}
            selectable
            numberOfLines={4}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            {profile.sampleSnippets[0]}
          </Text>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {profile.sampleSnippets.length > 1
              ? `+ ${plural(profile.sampleSnippets.length - 1, "more snippet")}. Snippets are edited on desktop.`
              : "Snippets are edited on desktop."}
          </Text>
        </View>
      ) : null}

      {profile.updatedAt ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Authored {relativeTime(profile.updatedAt)}
        </Text>
      ) : null}
    </View>
  );
}

function SubLabel({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontWeight: "600",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        fontFamily: FONT.semibold,
      }}
    >
      {children}
    </Text>
  );
}
