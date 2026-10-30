/**
 * Top referrers, and the one act a phone does better than a desktop: handing a
 * referral link to iMessage (MAP#43).
 *
 * WHY THE LINK IS FETCHED PER TAP AND NEVER FOR THE LIST.
 * GET /api/v1/subscribers/{id}/referral is a read with a WRITE side effect —
 * the handler calls `EnsureCode`, which mints the subscriber's referral code the
 * first time anybody asks. It is idempotent, so asking twice is harmless, but
 * asking on behalf of ten people nobody selected is not: it would create
 * referral codes as a side effect of scrolling. So the request is issued only
 * after an explicit press, one row at a time, and the affordance says "Get
 * referral link" rather than pretending the link was already there.
 *
 * WHAT A ROW SHOWS BEFORE THE TAP. `top_referrers` carries a subscriber UUID, a
 * 90-day credited count and a last-conversion timestamp — no email. The count
 * and the recency are the information; the UUID is a label, truncated, so it can
 * be cross-referenced without pretending to be a name. This is why the
 * leaderboard below still exists: it is the masked-email view of the same
 * population, and neither replaces the other.
 *
 * WHO MAY ASK. That minting side effect is also why the route is the one
 * `r.With(admin)` read on this screen while stats, payouts and variants are
 * `r.With(read)` — and `ScopeAdmin` on the session-cookie path is an owner|admin
 * ROLE check, not an API-key-only concern. So below that floor the button is not
 * merely likely to fail, it is guaranteed to: a 403 on every press, forever. It
 * is WITHHELD rather than disabled, because a disabled control on a phone is a
 * promise you cannot keep, and the card says why in one line so the absence
 * reads as a rule rather than a missing feature.
 *
 * NativeWind v4 GOTCHA: `style={({pressed}) => …}` silently drops layout on
 * Pressable. Every style here is a static object.
 */
import { useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Pressable, Share, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useCanMintSubscriberReferral,
  useSubscriberReferral,
} from "@/hooks/useReferrals";
import { FONT } from "@/lib/fonts";
import { num, relativeTime, truncateMiddle } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { referralWidgetSnippet } from "@/lib/referralAdmin";
import {
  REFERRAL_RUNTIME_AVAILABLE,
  SUBSCRIBER_REFERRAL_ROLE_NOTE,
  subscriberReferralErrorMessage,
  type ReferralTopReferrer,
} from "@/lib/referrals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ReferralTopReferrersCardProps {
  rows: readonly ReferralTopReferrer[];
}

export function ReferralTopReferrersCard({
  rows,
}: ReferralTopReferrersCardProps) {
  const { t } = useTheme();
  // One at a time: a second tap replaces the selection rather than accumulating
  // queries, which keeps the minting side effect proportional to intent.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The minting read mounts only while the runtime gate is open; with it
  // closed the query below is disabled by its own predicate, so the
  // affordance must go too — "Get link" spinning forever is not a state.
  // (Hook called unconditionally; the flag ANDs after.)
  const roleAllowsMint = useCanMintSubscriberReferral();
  const canMintLink = REFERRAL_RUNTIME_AVAILABLE && roleAllowsMint;
  // Held at null below the role floor so the hook's own gate can never see a
  // selection this session was not allowed to make — belt and braces with the
  // omitted Pressable, since a role can change under a screen already on-glass.
  const link = useSubscriberReferral(canMintLink ? selectedId : null);

  // Coerced, not trusted: this rides the persisted stats cache, whose shape is
  // only as good as the parser in the build that wrote it. A `.map` on a
  // non-array here would take the whole screen down for a card that has, at
  // worst, nothing to list.
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return null;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        marginHorizontal: 16,
        marginTop: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <Text
        {...typeCap("label")}
        accessibilityRole="header"
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Most referrals (90 days)
      </Text>

      {/* One line, not per row: the reason is a property of the session, and
          repeating it under every referrer would read as ten failures rather
          than one rule. Only while the runtime is OPEN — with the gate closed
          the screen's banner explains the absence, and blaming the role would
          be a false fact for an owner. */}
      {canMintLink || !REFERRAL_RUNTIME_AVAILABLE ? null : (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {SUBSCRIBER_REFERRAL_ROLE_NOTE}
        </Text>
      )}

      {list.map((row) => {
        const selected = canMintLink && row.subscriberId === selectedId;
        return (
          <View key={row.subscriberId} style={{ marginTop: 10 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
              }}
            >
              <View
                accessible
                accessibilityLabel={`${num(row.count)} credited referrals, referrer ${row.subscriberId}${
                  row.lastAt ? `, most recent ${relativeTime(row.lastAt)}` : ""
                }`}
                style={{ flexShrink: 1, flexGrow: 1 }}
              >
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fg,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {`${num(row.count)} referrals`}
                </Text>
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {[
                    `Referrer ${truncateMiddle(row.subscriberId, 13)}`,
                    row.lastAt ? `last ${relativeTime(row.lastAt)}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              {canMintLink ? (
                <Pressable
                  onPress={() =>
                    setSelectedId(selected ? null : row.subscriberId)
                  }
                  accessibilityRole="button"
                  accessibilityLabel={
                    selected
                      ? `Hide the referral link for referrer ${row.subscriberId}`
                      : `Get the referral link for referrer ${row.subscriberId}`
                  }
                  accessibilityHint={
                    selected
                      ? undefined
                      : "Asks the server for this subscriber's referral code, creating one if they do not have it yet"
                  }
                  accessibilityState={{ expanded: selected }}
                  hitSlop={8}
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <Text
                    {...typeCap("callout")}
                    style={{
                      color: t.accent,
                      ...typeStyle("callout"),
                      fontWeight: "600",
                      fontFamily: FONT.semibold,
                    }}
                  >
                    {selected ? "Hide link" : "Get link"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {selected ? (
              <SelectedLink
                loading={link.isLoading || link.isFetching}
                error={link.isError ? link.error : null}
                shareUrl={link.data?.shareUrl ?? ""}
                refCode={link.data?.refCode ?? ""}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * The expanded body under one selected referrer.
 *
 * The three states are kept apart on purpose. An in-flight mint is not "no
 * link", and a failed one is certainly not "no link" — rendering either as an
 * absent code would tell the operator this subscriber has no referral code when
 * the truth is that we have not been told yet.
 *
 * THE INSTALL SNIPPET rides here too: GET /api/public/r/{code}/widget.js is
 * mounted (widget.go, gate open) and serves a per-code "Refer a friend"
 * widget, but no client anywhere emitted the <script> tag that embeds it —
 * desktop's distribution workspace is feature-flagged off with no snippet
 * text behind it. The code this expansion just minted is exactly what the
 * snippet needs, so the copy affordance lives beside the share link rather
 * than in a separate card that would have to mint codes of its own.
 */
function SelectedLink({
  loading,
  error,
  shareUrl,
  refCode,
}: {
  loading: boolean;
  error: unknown;
  shareUrl: string;
  refCode: string;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const { baseUrl } = useOnlineQueryGate();
  const snippet = referralWidgetSnippet(baseUrl, refCode);

  const copySnippet = (text: string) => {
    Clipboard.setStringAsync(text)
      .then(() => {
        haptics.success();
        toast({ kind: "success", message: "Install snippet copied" });
      })
      .catch(() => {
        haptics.error();
        toast({
          kind: "error",
          message: "Couldn't reach the clipboard. Long-press the link to select it instead.",
        });
      });
  };

  if (error) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.danger,
          ...typeStyle("caption"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        {subscriberReferralErrorMessage(error)}
      </Text>
    );
  }
  if (loading || (shareUrl === "" && refCode === "")) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        {loading ? "Getting this referrer's link…" : "No link for this referrer."}
      </Text>
    );
  }

  return (
    <View style={{ marginTop: 6 }}>
      {refCode ? (
        <Text
          selectable
          accessibilityLabel={`Referral code ${refCode}`}
          {...typeCap("mono")}
          style={{
            color: t.fg,
            ...typeStyle("mono"),
            fontFamily: "Menlo",
          }}
        >
          {refCode}
        </Text>
      ) : null}
      {shareUrl ? (
        <>
          <Text
            selectable
            accessibilityLabel={`Referral link ${shareUrl}`}
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {shareUrl}
          </Text>
          <Pressable
            onPress={() => {
              void Share.share({ message: shareUrl }).catch(() => {
                /* dismissed */
              });
            }}
            accessibilityRole="button"
            accessibilityLabel="Share this referral link"
            accessibilityHint="Opens the system share sheet"
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Share link
            </Text>
          </Pressable>
        </>
      ) : null}
      {snippet ? (
        <Pressable
          onPress={() => copySnippet(snippet)}
          accessibilityRole="button"
          accessibilityLabel="Copy the website widget install snippet for this referrer"
          accessibilityHint="Copies a script tag that embeds the public referral widget on a website"
          hitSlop={8}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accent,
              ...typeStyle("callout"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Copy install snippet
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
