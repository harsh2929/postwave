/**
 * LookalikeDetailSheet — what this model is made of, how good it is, and the
 * one deliberate step that puts real people's addresses on a phone screen.
 *
 * A SHEET RATHER THAN A ROUTE, for the same reasons AudienceSyncDetailSheet is:
 * the rhythm is open → judge → close, a pushed screen charges a navigation
 * animation each way, and it keeps this surface to ONE route file.
 *
 * IT OPENS WITHOUT MAKING A REQUEST. `ListLookalikes` and `GetLookalike` select
 * the identical fourteen columns (subscribers/lookalike.go:206-211 vs :250-255),
 * so everything above the member section is already in hand from the list. The
 * only reason to talk to the server again is to ask for people.
 *
 * THE MEMBER REVEAL IS A DELIBERATE ACT, AND THAT MIRRORS THE HANDLER. The
 * detail route returns an EMPTY members array unless `include_pii=true`
 * (lookalike.go:262); the type comment states the intent outright — the default
 * is aggregate-only "so a status poll cannot accidentally hydrate subscriber
 * PII" (types.go:478-481). A phone is the most over-the-shoulder device we
 * ship, so this sheet keeps that default rather than defeating it: nothing is
 * fetched until somebody presses the button, and the button says what it will
 * do before it does it.
 *
 * `pii_included` IS READ BACK RATHER THAN ASSUMED. "The server sent no members"
 * and "the server withheld the members" are different sentences, and only one
 * of them means this audience is empty. The flag is echoed by the handler for
 * exactly this reason, so it is what decides which sentence renders.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { Pill } from "@/components/Pill";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { LookalikeMemberRow } from "@/components/lookalike/LookalikeMemberRow";
import { LookalikeModelFacts } from "@/components/lookalike/LookalikeModelFacts";
import { LookalikeQualityPanel } from "@/components/lookalike/LookalikeQualityPanel";
import { FONT } from "@/lib/fonts";
import { num, plural } from "@/lib/format";
import {
  lookalikeHealthPresentation,
  lookalikeHealthState,
} from "@/lib/lookalikeHealth";
import {
  LOOKALIKE_MEMBER_SAMPLE_SIZE,
  lookalikeName,
  type LookalikeAudience,
  type LookalikeMember,
} from "@/lib/lookalikeAudiences";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface LookalikeDetailSheetProps {
  audience: LookalikeAudience | null;
  /** Resolved from the segments catalogue; null when it could not be read. */
  seedName: string | null;
  onClose: () => void;
  /** True once the reader has asked for identities. */
  revealed: boolean;
  onReveal: () => void;
  members: readonly LookalikeMember[];
  membersQuery: QueryLike;
  /** The server's own statement about whether it sent identities. */
  piiIncluded: boolean;
  /** The online/auth gate, so the member list says "offline" not "empty". */
  gate: { enabled: boolean };
  online: boolean;
}

export function LookalikeDetailSheet(props: LookalikeDetailSheetProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const audience = props.audience;
  const state = audience ? lookalikeHealthState(audience) : null;
  const health = state ? lookalikeHealthPresentation(state) : null;
  const settled = state !== "building" && state !== "unknown";

  return (
    <ReducedMotionModal
      visible={audience !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            gap: 12,
          }}
        >
          <Text
            numberOfLines={maxLinesAtScale(2, fontScale)}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.display,
              flexShrink: 1,
            }}
          >
            {audience ? lookalikeName(audience) : "Lookalike"}
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            style={{
              minHeight: 44,
              minWidth: 44,
              alignItems: "flex-end",
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              Close
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: 32,
            gap: 12,
          }}
        >
          {audience && health ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Pill
                label={health.label}
                tone={health.tone}
                accessibilityLabel={health.spoken}
              />
              {audience.status === null && audience.rawStatus ? (
                <Pill
                  label={audience.rawStatus}
                  tone="warning"
                  accessibilityLabel={`The server reported the state "${audience.rawStatus}", which this app does not recognise.`}
                />
              ) : null}
              {audience.modelVersion ? (
                <Pill
                  label={audience.modelVersion}
                  tone="neutral"
                  accessibilityLabel={`Built by model version ${audience.modelVersion}.`}
                />
              ) : null}
            </View>
          ) : null}

          {audience ? (
            <LookalikeQualityPanel audience={audience} settled={settled} />
          ) : null}
          {audience ? (
            <LookalikeModelFacts
              audience={audience}
              seedName={props.seedName}
              settled={settled}
            />
          ) : null}

          <SectionHeading>Ranked members</SectionHeading>

          {audience ? (
            <MemberSection
              audience={audience}
              settled={settled}
              revealed={props.revealed}
              onReveal={props.onReveal}
              members={props.members}
              membersQuery={props.membersQuery}
              piiIncluded={props.piiIncluded}
              gate={props.gate}
              online={props.online}
            />
          ) : null}

          <MobileScopeNotice
            title="Monitoring only, on purpose"
            body="Generating a lookalike stays on desktop: it needs a seed segment picked from the whole catalogue, a size, a confidence floor, and a first-party data-use acknowledgement that gets filed as a versioned compliance record. Discarding one cascades every member with no undo. Neither belongs behind a thumb."
          />
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function MemberSection({
  audience,
  settled,
  revealed,
  onReveal,
  members,
  membersQuery,
  piiIncluded,
  gate,
  online,
}: {
  audience: LookalikeAudience;
  settled: boolean;
  revealed: boolean;
  onReveal: () => void;
  members: readonly LookalikeMember[];
  membersQuery: QueryLike;
  piiIncluded: boolean;
  gate: { enabled: boolean };
  online: boolean;
}) {
  const { t } = useTheme();

  if (!settled) {
    return (
      <Body>
        This model has not finished building, so there is no ranked list behind
        it yet.
      </Body>
    );
  }
  if (audience.memberCount === 0) {
    return (
      <Body>
        The model matched nobody, so there is nothing to rank. Sending to this
        audience would reach no one.
      </Body>
    );
  }
  if (!revealed) {
    return (
      <View style={{ gap: 8 }}>
        <Body>
          Nothing has been requested yet. The server withholds member identities
          unless they are explicitly asked for, and this screen keeps that
          default — looking at a model does not pull real addresses onto your
          phone.
        </Body>
        <Pressable
          onPress={onReveal}
          disabled={!online}
          accessibilityRole="button"
          accessibilityLabel={`Show the ${LOOKALIKE_MEMBER_SAMPLE_SIZE} most similar members`}
          accessibilityHint="Requests real subscriber email addresses from the server and shows them on this screen"
          accessibilityState={{ disabled: !online }}
          style={{
            minHeight: 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 12,
            backgroundColor: online ? t.accent : t.surface,
            borderWidth: 1,
            borderColor: online ? t.accent : t.borderSubtle,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: online ? t.accentFg : t.fgSubtle,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            Show the top {LOOKALIKE_MEMBER_SAMPLE_SIZE} members
          </Text>
        </Pressable>
        {online ? null : (
          <Body>
            You are offline, so identities cannot be requested. They are never
            cached to this device either — nothing on this screen is written to
            disk.
          </Body>
        )}
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <QueryStates
        query={membersQuery}
        gate={gate}
        isEmpty={members.length === 0}
        offlineMessage="You're offline, so the ranked members can't be loaded. They are never cached to this device."
        skeleton={<SkeletonList rows={4} />}
        empty={
          piiIncluded
            ? {
                title: "No members returned",
                description:
                  "The server reports it sent identities and there were none on this page, even though the header counts members. That mismatch is worth a look on desktop.",
              }
            : {
                title: "Identities withheld",
                description:
                  "The server answered without member identities, so this is not an empty audience — it is an audience whose people were not sent.",
              }
        }
      >
        <View style={{ gap: 8 }}>
          {members.map((member) => (
            <LookalikeMemberRow key={member.subscriberId} member={member} />
          ))}
          <Body>
            The {plural(members.length, "most similar member")} of{" "}
            {num(audience.memberCount)}. This is a sample for judging the model,
            not the audience itself — the whole thing is used on desktop.
          </Body>
        </View>
      </QueryStates>
    </View>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function SectionHeading({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.semibold,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        marginTop: 4,
      }}
    >
      {children}
    </Text>
  );
}
