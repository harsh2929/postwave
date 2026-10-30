/**
 * TrackingKeysPanel — revoke a leaked public conversion site key.
 *
 * The sibling IngestSecretsPanel ports this exact verb for HMAC signing keys,
 * and its doctrine reaches further than it was applied: a site key ships
 * INSIDE the tenant's own storefront JavaScript, so it is public by design and
 * "leaked" is its resting state. Anyone holding it can forge conversion
 * events, which corrupts attribution and therefore revenue reporting. The
 * window between noticing and revoking is the whole risk, and it is rarely
 * spent at a desk.
 *
 * Issuing stays on the web or desktop admin for the same reason it does next door: the
 * plaintext key is returned exactly once and wants a capture ceremony.
 *
 * Admin-only, and BELOW admin the panel renders nothing at all — the query
 * never runs, and an empty "keys" list would imply a fact the session cannot
 * know.
 */
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { useRevokeTrackingKey, useTrackingKeys } from "@/hooks/useTrackingKeys";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  trackingKeyIsActive,
  trackingKeyRevokeCopy,
  type TrackingKey,
} from "@/lib/trackingKeys";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function TrackingKeysPanel() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const query = useTrackingKeys();
  const revoke = useRevokeTrackingKey();

  // Below admin (and while the online gate is closed) the query never runs;
  // rendering an empty section then would read as "no keys", which on a
  // security surface is the wrong implication. A FAILED read is different:
  // hiding it would render the same nothing, and "nothing" must never be how
  // an admin learns the register could not be read.
  if (query.data === undefined && !query.isError) return null;
  const keys = Array.isArray(query.data) ? query.data : [];
  const active = keys.filter(trackingKeyIsActive);

  const onRevoke = async (key: TrackingKey) => {
    haptics.tap();
    const copy = trackingKeyRevokeCopy(key);
    // Every page the tenant ships authenticates with SOME live key. Revoking
    // the last one stops all browser conversion tracking, not just the leak.
    const lastLive =
      active.length <= 1
        ? " This is the last live site key: browser conversion tracking stops until a new one is issued."
        : "";
    const ok = await confirm({
      title: copy.title,
      message: copy.body + lastLive,
      confirmLabel: copy.confirmLabel,
      destructive: true,
    });
    if (!ok) return;
    revoke.mutate(key.id, {
      onSuccess: () =>
        toast({ kind: "success", message: `${key.label} revoked.` }),
      onError: (err) =>
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || `Couldn't revoke ${key.label}.`,
        }),
    });
  };

  return (
    <View style={{ gap: 8, marginTop: 16 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        Site tracking keys
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        These ship inside your site&apos;s JavaScript, so anyone can read one
        and submit conversion events with it. It does not create an HMAC
        signature and must never be used as a signing secret. New keys are
        issued on the web or desktop admin, where the full value can be
        captured.
      </Text>
      {query.isError ? (
        <View
          accessibilityRole="alert"
          style={{
            borderColor: t.danger,
            borderWidth: 1,
            borderRadius: 10,
            padding: 10,
            gap: 6,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.danger,
              ...typeStyle("body"),
              fontFamily: FONT.semibold,
            }}
          >
            Site-key register unavailable
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {errorPresentation(query.error).message ||
              "Moosewave could not read the site-key register, so a leaked key may still be live."}
          </Text>
          <Pressable
            onPress={() => void query.refetch()}
            accessibilityRole="button"
            accessibilityLabel="Retry site-key register"
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              Retry
            </Text>
          </Pressable>
        </View>
      ) : null}
      {!query.isError && keys.length === 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          No site tracking keys are registered.
        </Text>
      ) : null}
      {keys.map((key, index) => {
        const live = trackingKeyIsActive(key);
        // A revoked row stays, with when it died; only the verb leaves.
        const meta = [
          key.prefix ? `Prefix ${key.prefix}` : "",
          key.createdAt ? `issued ${key.createdAt}` : "",
          key.revokedAt ? `revoked ${key.revokedAt}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <View
            // The hook's parser guarantees an id; a persisted cache restored
            // from an older shape does not, and must not warn or collide.
            key={key.id || `row-${index}`}
            style={{
              borderTopColor: t.borderSubtle,
              borderTopWidth: 1,
              paddingTop: 10,
              gap: 4,
            }}
          >
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.semibold,
                  flexShrink: 1,
                }}
                numberOfLines={1}
              >
                {key.label}
              </Text>
              <Pill
                label={live ? "active" : "revoked"}
                tone={live ? "success" : "neutral"}
              />
            </View>
            {meta ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
              >
                {meta}
              </Text>
            ) : null}
            {live ? (
              <Pressable
                onPress={() => void onRevoke(key)}
                disabled={revoke.isPending}
                accessibilityRole="button"
                accessibilityLabel={`Revoke the site tracking key ${key.label}`}
                accessibilityState={{ disabled: revoke.isPending }}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text
                  {...typeCap("control")}
                  style={{
                    color: revoke.isPending ? t.fgSubtle : t.danger,
                    ...typeStyle("control"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  {revoke.isPending ? "Revoking…" : "Revoke key"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
