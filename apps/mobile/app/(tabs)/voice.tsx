/**
 * Voice tab — the workspace's MEASURED brand voice.
 *
 * What this screen must never do (the bug it was rebuilt to fix): claim that
 * no voice profile exists when the app has not talked to the server at all.
 * With the online gate closed the query never runs, so TanStack leaves
 * `data === undefined` with `isLoading === false` and `isError === false` —
 * which used to fall straight through into "No voice profile yet". That is a
 * manufactured negative claim about tenant state, and it invites the operator
 * to rebuild a profile that already exists. The gate notice is now checked
 * BEFORE the data ternary, and pull-to-refresh respects the same gate
 * (`refetch()` deliberately ignores `enabled` in TanStack v5, so a pull would
 * otherwise punch straight through the session-validation contract).
 */
import { useCallback, useRef, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { goBackOrMore } from "@/lib/nav";

import { Card } from "@/components/Card";
import { CachedSessionNotice } from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { SkeletonCard } from "@/components/Skeleton";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { useToast } from "@/components/Toast";
import { useTourTarget } from "@/components/tour/TourProvider";
import { FONT } from "@/lib/fonts";
import { relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";
import {
  useBuildVoiceProfile,
  useVoiceProfile,
  voiceBuildErrorMessage,
  type VoiceProfile,
} from "@/hooks/useVoice";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  voiceCachedSessionNotice,
  voiceDistinctiveTerms,
  voicePersonaSummary,
  voiceSamples,
  voiceSourceLines,
  voiceStyleStats,
  voiceToneAxes,
  voiceToneSummary,
} from "@/lib/voiceProfile";

import { AiChatLinkCard } from "@/components/ai-chat/AiChatLinkCard";
import { AiRegressionCard } from "@/components/voice/AiRegressionCard";
import { BrandVoiceCard } from "@/components/voice/BrandVoiceCard";
import { SubjectLabLinkCard } from "@/components/voice/SubjectLabLinkCard";
import { VoiceFingerprint } from "@/components/voice/VoiceFingerprint";
import { VoiceSourcesCard } from "@/components/voice/VoiceSourcesCard";
import { VoiceTemplatesCard } from "@/components/voice/VoiceTemplatesCard";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function Voice() {
  const { t } = useTheme();
  const { toast } = useToast();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const profile = useVoiceProfile();
  const build = useBuildVoiceProfile();
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  useScreenViewed("voice");

  const notice = voiceCachedSessionNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
  });

  // Tour target — register the voice profile card.
  const profileRef = useRef<View>(null);
  useTourTarget("voice.profile", profileRef);

  const onRefresh = useCallback(() => {
    // Same early return the sequences list uses: a gesture must not be the one
    // path that bypasses the online gate.
    if (notice) return;
    haptics.tap();
    void profile.refetch();
  }, [notice, profile]);

  const data = profile.data?.profile ?? null;
  // Live session, but the fetch fell back to the stored projection (network
  // dropped mid-request). No gate notice applies, so the rows need their own
  // label — otherwise a saved copy reads as a fresh measurement.
  const fromSnapshot = profile.data?.fromSnapshot ?? false;
  // POST /api/v1/voice/profile/build is `write:campaigns` (see useVoice), i.e.
  // editor and above. The gate used to be connectivity ALONE, so a viewer was
  // offered "Build profile" — and its only possible outcome was a 403 toast.
  const canBuild =
    !notice &&
    gate.enabled &&
    canAccessMinimumRole("editor", gate.effectiveRole, mode);
  // PUT /api/v1/voice/brand-profile is `apikeys.ScopeAdmin`, so anything less
  // than admin gets the read and no button that could only ever 403.
  //
  // Compared through the ROLE RANK, not string equality: `=== "admin"` denied
  // the edit to an OWNER — the role the server admits first, and the one the
  // person who created the workspace actually holds — while admitting an
  // api_key session, which carries no role claim the server will honour.
  const isAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  // Source writes are write:campaigns, i.e. editor and above — a lower bar
  // than the admin-only authored profile above.
  const canEditSources = canAccessMinimumRole(
    "editor",
    gate.effectiveRole,
    mode,
  );
  const onBuild = useCallback(() => {
    if (!canBuild || build.isPending) return;
    build.mutate(undefined, {
      onSuccess: () => {
        setBuiltAt(Date.now());
        toast({
          kind: "success",
          message: "Rebuild started. It runs on the server — pull to refresh.",
        });
      },
      onError: (err) => {
        toast({ kind: "error", message: voiceBuildErrorMessage(err) });
      },
    });
  }, [build, canBuild, toast]);

  const generatedLine = data?.generated_at
    ? `Measured ${relativeTime(data.generated_at)}`
    : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Voice"
        subtitle={notice ? "Offline · showing cached" : generatedLine}
        onBack={goBackOrMore}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={profile.isFetching && !profile.isLoading}
            onRefresh={onRefresh}
            enabled={!notice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {notice && data ? (
          <CachedSessionNotice notice={notice} variant="stale" />
        ) : fromSnapshot ? (
          <StaleDataBanner
            message="Showing the saved copy of your voice profile."
            onRetry={onRefresh}
          />
        ) : null}

        <View ref={profileRef} collapsable={false}>
          <Card>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
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
                Voice profile
              </Text>
              {data?.version ? (
                <Pill label={`v${data.version}`} tone="neutral" />
              ) : null}
            </View>

            {notice && !data ? (
              <CachedSessionNotice notice={notice} style={{ marginTop: 10 }} />
            ) : profile.isLoading ? (
              <SkeletonCard lines={3} />
            ) : profile.isError ? (
              <ErrorState
                compact
                error={profile.error}
                onRetry={() => void profile.refetch()}
              />
            ) : data ? (
              <ProfileSummary profile={data} />
            ) : (
              <View style={{ marginTop: 10 }}>
                <EmptyState
                  title="No voice profile yet"
                  description="Moosewave measures your brand voice from your past sends and connected sources. Build one to ground every AI draft in how you actually write."
                  {...(canBuild
                    ? {
                        cta: {
                          label: build.isPending
                            ? "Starting…"
                            : "Build profile",
                          onPress: onBuild,
                        },
                      }
                    : {})}
                />
              </View>
            )}
          </Card>
        </View>

        {/* Authored BEFORE measured: an operator's own instructions outrank a
            derived observation, and reading them in that order is what makes
            a disagreement between the two legible instead of confusing. */}
        <BrandVoiceCard canEdit={isAdmin} offline={Boolean(notice)} />

        {/* Sources sit between the two profiles: they are the INPUT the
            measured fingerprint below is derived from. */}
        <VoiceSourcesCard canWrite={canEditSources} offline={Boolean(notice)} />

        {/* The AI capability on this device was real but homeless — generation
            lives inside the campaign subject sheet, measurement lives here, and
            neither pointed at the other. This is the one link that makes them
            read as one surface. */}
        <SubjectLabLinkCard />

        {/* Chat is the other half of the same surface: Subject Lab answers
            "is this line any good", the chat writes the thing in the voice
            measured above. Additive link only — the screen gates itself. */}
        <AiChatLinkCard />

        {/* The shared prompt library sits with the two AI links because it is
            the INPUT to both: a starter to paste into the chat, or a brief the
            generator writes from. Browsing is read:campaigns (viewer);
            generating is editor and delete is admin, so the card is given the
            roles this screen already computed rather than guessing. */}
        <VoiceTemplatesCard
          offline={Boolean(notice)}
          canGenerate={canEditSources}
          canAdmin={isAdmin}
        />

        {data ? (
          <VoiceFingerprint
            axes={voiceToneAxes(data)}
            stats={voiceStyleStats(data)}
            terms={voiceDistinctiveTerms(data)}
            samples={voiceSamples(data)}
            sources={voiceSourceLines(data)}
            onRebuild={canBuild ? onBuild : undefined}
            rebuilding={build.isPending}
            rebuildQueued={builtAt !== null}
          />
        ) : null}

        {/* Last, because it is a check ON everything above rather than part
            of the profile itself. */}
        <AiRegressionCard offline={Boolean(notice)} canAdmin={isAdmin} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ProfileSummary({ profile }: { profile: VoiceProfile }) {
  const { t } = useTheme();
  const persona = voicePersonaSummary(profile);
  return (
    <View style={{ marginTop: 8, gap: 8 }}>
      <View>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Tone
        </Text>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={3}
        >
          {voiceToneSummary(profile)}
        </Text>
      </View>
      {persona ? (
        <View>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            Recurring themes
          </Text>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.regular,
            }}
            numberOfLines={3}
          >
            {persona}
          </Text>
        </View>
      ) : null}
      {profile.generated_at ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Generated {relativeTime(profile.generated_at)}
        </Text>
      ) : null}
    </View>
  );
}
