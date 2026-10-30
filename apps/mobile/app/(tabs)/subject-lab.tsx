/**
 * Subject Lab — the phone-shaped half of Moosewave AI.
 *
 * Desktop's Moosewave AI is a six-mode workspace (chat, compose, subject lab,
 * pre-send, agent, routines). Most of it does not belong on a phone: chat
 * wants a long transcript, compose wants a body editor. Two things do — a
 * short input that returns a verdict — and mobile already had one of them
 * without a home: `SubjectLineSuggestions` GENERATES subject lines inside the
 * campaign subject sheet, but nothing on the device could ever tell you
 * whether a subject line was any good.
 *
 * That is what this screen adds, and it is deliberately grounded in the
 * workspace's OWN history rather than in generic advice:
 *
 *   · "What works for your list" — GET /api/v1/subject-analyzer/buckets,
 *     viewer-readable, the observed open rate per subject-line attribute.
 *   · "Write some options" — POST /api/v1/subject-lab/variants, the
 *     axis-conditioned generator desktop and web both reach.
 *   · "Score a subject line" — POST /api/v1/subject-lab/score, the
 *     per-candidate prediction with its Wilson-90% band.
 *
 * GENERATE FEEDS SCORE, which is the only reason generation belongs here
 * rather than being a second copy of the campaign sheet's suggestion strip.
 * "Score these" hands the seed AND its variants down with the seed FIRST: the
 * question a person has is "is any of these better than what I already
 * wrote", and a ranking that omits the incumbent cannot answer it.
 *
 * THE AUTHORIZATION SPLIT IS THE DESIGN. apps/api authorises twice — the
 * `apikeys.RequireScope(...)` wrapper at the mount site and
 * `routeauth.Middleware` reading routeauth/manifest.json — and for these
 * routes the gates disagree, so both have to be measured. The evidence rollup
 * mounts `read:reports` and is `viewer` in the manifest; the two composer
 * routes both mount `write:campaigns` (subject_lab.go MountRoutes) and are
 * `editor` in the manifest. A screen that read only the handler files would
 * put a permanently-403ing button in front of every viewer.
 *
 * The composer half is gated at that measured floor — `editor` — and not one
 * notch above it. It shipped at `admin`, which is stricter than the server and
 * therefore safe from a 403, but it was not correct and it was not honest: an
 * editor is entitled to both routes, and the refusal named a server rule that
 * neither subject_lab.go nor the manifest contains. A client may be stricter
 * than the server only where it can say why in its own name; here there was no
 * such reason, so the gate moved to the floor rather than the copy inventing
 * one. Generation is gated on the SAME bit as scoring on purpose — generating
 * candidates for someone who cannot score them is a button that leads nowhere.
 *
 * `/variants` carries one gate more: the per-tenant `subject_lab` feature
 * flag, off by default because it is the LLM-spend endpoint. There is no
 * probe for it, so the control is offered and the server's entitlement
 * refusal is RENDERED (lib/denialEnvelope already has the sentence for
 * `reason: "flag"`). Pre-hiding it would lie to every workspace that has it.
 *
 * Nothing here is offered while the online gate is closed: both surfaces are
 * live reads of tenant history with no offline projection, so a cached answer
 * would be a claim about the workspace this device cannot stand behind.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CachedSessionNotice } from "@/components/CachedSessionNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SubjectEvidencePanel } from "@/components/voice/SubjectEvidencePanel";
import { SubjectLabScorePanel } from "@/components/voice/SubjectLabScorePanel";
import { SubjectLabVariantsPanel } from "@/components/voice/SubjectLabVariantsPanel";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useSubjectBuckets } from "@/hooks/useSubjectLab";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { readSubjectLabArrival } from "@/lib/subjectLabSeed";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

const GATE_NOTICE = {
  title: "Reconnect to open Subject Lab",
  description:
    "Both halves of this screen read your live send history, and neither has an offline copy. Reconnect to score a subject line.",
  staleMessage:
    "Reconnect before refreshing your subject-line history. Showing the last loaded results.",
};

const NO_TENANT_NOTICE = {
  title: "Reconnect your workspace",
  description:
    "This screen needs an authenticated workspace before it can read your send history.",
  staleMessage:
    "Reconnect your workspace before refreshing. Showing anything already cached.",
};

export default function SubjectLab() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const buckets = useSubjectBuckets({ enabled: gate.enabled });
  useScreenViewed("subject-lab");

  // Arrival FROM a campaign (CampaignSubjectLabLink): `?seed` pre-fills BOTH
  // lab boxes with the campaign's actual subject, `?campaignId` arms the
  // lab → bandit handoff against that campaign's audience. The grammar is
  // lib/subjectLabSeed, the same module the link encodes with. Keyed on the
  // param VALUES, not the params object — this route is a still-mounted hidden
  // tab screen, so a second arrival lands as new params, and the params object
  // is a fresh identity every render (the templates screen documents the trap).
  const params = useLocalSearchParams<{ seed?: string; campaignId?: string }>();
  const { seed: seedParam, campaignId } = readSubjectLabArrival(params);
  const seedHandoff = useMemo(
    () => (seedParam ? { seed: seedParam } : undefined),
    [seedParam],
  );
  // The seed reaches the SCORER as well as the generator. `/variants` is the
  // flag-gated LLM endpoint, off by default, and "Score these" only fires once
  // variants exist — so a seed that reached the generator alone would strand
  // behind an entitlement refusal and the person would retype it, which is the
  // copy-paste the link exists to remove. Scoring the campaign's own subject
  // needs neither the flag nor a generation.
  const seedScore = useMemo(
    () => (seedParam ? { candidates: seedParam } : undefined),
    [seedParam],
  );

  // A fresh object per handoff, never the string: tapping "Score these" twice
  // on the same variants has to refill a box the person has since emptied,
  // and identity is the only thing that still differs then. Tagged with the
  // seed it was scored under, so a LATER arrival from another campaign shows
  // that campaign's subject rather than the previous campaign's list.
  const [scored, setScored] = useState<
    { candidates: string; seed: string | null } | undefined
  >(undefined);
  const onScoreThese = useCallback(
    (candidates: string) => {
      setScored({ candidates, seed: seedParam });
    },
    [seedParam],
  );
  const handoff = scored && scored.seed === seedParam ? scored : seedScore;

  const notice = !gate.enabled
    ? gate.tenantId
      ? GATE_NOTICE
      : NO_TENANT_NOTICE
    : null;
  const offline = notice !== null;

  // The composer half of the screen — generate AND score. See the header: the
  // measured server floor for both routes is `editor` (subject_lab.go mounts
  // write:campaigns, routeauth/manifest.json says session_minimum_role
  // "editor"), and this is that floor rather than a stricter invention. One bit
  // for both, because candidates you cannot score are candidates you cannot use.
  const canCompose = canAccessMinimumRole("editor", gate.effectiveRole, mode);

  const onRefresh = useCallback(() => {
    // A pull must not be the one path that bypasses the online gate:
    // TanStack's refetch() deliberately ignores `enabled`.
    if (offline) return;
    haptics.tap();
    void buckets.refetch();
  }, [buckets, offline]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Subject Lab"
        subtitle={
          offline ? "Offline · reconnect to score" : "Grounded in your own sends"
        }
        onBack={goBackOrMore}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={buckets.isFetching && !buckets.isLoading}
            onRefresh={onRefresh}
            enabled={!offline}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {notice ? <CachedSessionNotice notice={notice} /> : null}

        {canCompose ? (
          <>
            <SubjectLabVariantsPanel
              offline={offline}
              onScoreThese={onScoreThese}
              seedHandoff={seedHandoff}
            />
            <SubjectLabScorePanel
              offline={offline}
              handoff={handoff}
              banditCampaignId={campaignId}
            />
          </>
        ) : (
          <View
            style={{
              backgroundColor: t.surface,
              borderColor: t.borderSubtle,
              borderWidth: 1,
              borderRadius: 12,
              padding: 12,
              gap: 6,
            }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.semibold,
              }}
            >
              Writing and scoring need editor access
            </Text>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              Anyone with editor access or above can write candidate subject
              lines and score them against your send history. The patterns below
              are open to everyone.
            </Text>
          </View>
        )}

        <SubjectEvidencePanel offline={offline} />
      </ScrollView>
    </SafeAreaView>
  );
}
