/**
 * StoreCard — one commerce connection, and whether its pipeline is flowing.
 *
 * The card leads with the sync CURSOR rather than with the integration's
 * `status` field, because "active" is what the row says right up until the
 * moment a backfill dies on a 401 — the status describes the connection, the
 * cursor describes the data. A store can be perfectly "active" and not have
 * ingested an order in six days.
 *
 * State is never carried by colour alone: every tone is paired with a labelled
 * Pill and a sentence, and the readable half of the card is one accessible
 * element so VoiceOver reads a fact rather than walking five fragments.
 *
 * TWO PRESSABLES, NEVER NESTED. The card body selects the store and the
 * "Resume sync" button performs a write, so they are SIBLINGS inside a plain
 * View. Nesting the button inside the card's own Pressable would give the
 * platform two overlapping touch responders — a tap near the button edge
 * silently selects instead of syncing, and VoiceOver announces a button inside
 * a button. `noNestedInteractiveControls.test.ts` is the guard that catches it.
 *
 * THE ACTION ROW lives in `StoreCardActions`, a SIBLING of the card body for
 * the reason above. Which verbs it offers, and why a paused store keeps a
 * disabled Pause button, is documented there.
 *
 * NativeWind v4: static style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { StoreCardActions } from "@/components/commerce/StoreCardActions";
import { isStorePaused } from "@/lib/commerceConnection";
import type { CommerceStore, CommerceSyncTone } from "@/lib/commerceRollup";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface StoreCardProps {
  store: CommerceStore;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Undefined hides the action entirely (no admin scope / offline). */
  onResume?: ((store: CommerceStore) => void) | undefined;
  resuming: boolean;
  /** Undefined hides the action entirely (not owner/admin, or offline). */
  onPause?: ((store: CommerceStore) => void) | undefined;
  pausing?: boolean | undefined;
  /** Undefined hides the overflow entirely (not owner/admin, or offline). */
  onMore?: ((store: CommerceStore) => void) | undefined;
}

function syncTone(tone: CommerceSyncTone): PillTone {
  if (tone === "ok") return "success";
  if (tone === "failed") return "danger";
  if (tone === "retrying") return "warning";
  return "neutral";
}

export function StoreCard({
  store,
  selected,
  onSelect,
  onResume,
  resuming,
  onPause,
  pausing = false,
  onMore,
}: StoreCardProps) {
  const { t } = useTheme();
  const rel = relativeTime(store.lastSyncAt, { fallback: "" });
  const abs = dateTime(store.lastSyncAt, "");
  const disconnected = store.status.toLowerCase() === "disconnected";
  const paused = isStorePaused(store.status);
  const title = store.shopDomain || store.provider;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: selected ? t.accent : t.borderSubtle,
        borderWidth: selected ? 2 : 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
      }}
    >
      <Pressable
        onPress={() => onSelect(store.id)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${title}, ${store.provider}, ${store.status}. ${
          store.sync.label
        }.${abs ? ` Last sync ${abs}.` : " Never synced."}${
          store.errorMessage ? ` ${store.errorMessage}` : ""
        } ${selected ? "Showing its numbers." : "Show its numbers."}`}
        style={{ minHeight: 44 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
              numberOfLines={1}
            >
              {title}
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                marginTop: 2,
                fontFamily: FONT.regular,
              }}
              numberOfLines={1}
            >
              {rel
                ? `${store.provider} · synced ${rel}`
                : `${store.provider} · never synced`}
            </Text>
          </View>
          <Pill
            label={store.status}
            tone={disconnected ? "danger" : paused ? "warning" : "neutral"}
          />
        </View>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginTop: 10,
            flexWrap: "wrap",
          }}
        >
          <Pill label={store.sync.tone} tone={syncTone(store.sync.tone)} />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
          >
            {store.sync.label}
          </Text>
        </View>

        {store.sync.lastError || store.errorMessage ? (
          <Text
            selectable
            {...typeCap("label")}
            style={{
              color: t.danger,
              ...typeStyle("label"),
              marginTop: 8,
              fontFamily: FONT.regular,
            }}
          >
            {store.sync.lastError || store.errorMessage}
          </Text>
        ) : null}
      </Pressable>

      <StoreCardActions
        store={store}
        title={title}
        disconnected={disconnected}
        paused={paused}
        onResume={onResume}
        resuming={resuming}
        onPause={onPause}
        pausing={pausing}
        onMore={onMore}
      />
    </View>
  );
}
