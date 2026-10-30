/**
 * PasskeysSection — the passkeys that can sign in as this user.
 *
 * MANAGEMENT ONLY, and the split matters. Creating a passkey needs a platform
 * authenticator and a WebAuthn ceremony validated against the server's
 * RPOrigins; the Expo app bundles no passkey module, so enrollment is genuinely
 * out of reach here. Listing, renaming and deleting are ordinary authenticated
 * JSON calls needing no authenticator at all — so "passkeys are not supported on
 * mobile" was true of half the surface and quietly applied to all of it. A user
 * whose passkey lived on a lost laptop could not remove it from their phone.
 *
 * RENAME IS THE HALF THAT WAS STILL MISSING. The transport, the hook and the
 * server route all existed (PATCH /api/v1/auth/webauthn/credentials/{id});
 * nothing rendered a way to reach them, so every row offered exactly one verb
 * and it was the destructive one. On a list whose rows are otherwise
 * indistinguishable — "Unnamed passkey · Not used yet", twice — naming a
 * credential is the only way to know WHICH one delete would remove.
 *
 * Same rule as ActiveDevicesSection: nothing is cached. A stale list on a
 * security screen invites a user to believe a credential they can see still
 * exists, or that one they cannot see is gone.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { QueryStates } from "@/components/QueryStates";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import {
  useDeletePasskey,
  usePasskeys,
  useRenamePasskey,
  type PasskeyCredential,
} from "@/hooks/usePasskeys";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { pathLabel } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { fontSizeFor, typeCap } from "@/lib/typeScale";
import { useTheme, type ThemeTokens } from "@/lib/theme";

/**
 * The server clamps a passkey name to 100 BYTES and rewrites a blank one to
 * "Passkey" (apps/api/internal/auth/webauthn_handlers.go clampPasskeyName), so
 * this ceiling is an approximation for multi-byte names — which is fine,
 * because the mutation invalidates the list and what the row ends up showing is
 * the server's value, not the typed one.
 */
const MAX_NAME_LENGTH = 100;

/**
 * "Never used" is a fact; a zero-date fallback renders as 1970 and reads real.
 *
 * `date()` from lib/format rather than toLocaleDateString: it guards Invalid
 * Date and honours setFormatLocale(), which a raw Intl call does not.
 */
function lastUsedLabel(row: PasskeyCredential): string {
  if (!row.last_used_at) return "Not used yet";
  const rendered = date(row.last_used_at, "");
  return rendered ? `Last used ${rendered}` : "Not used yet";
}

export function PasskeysSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  const passkeys = usePasskeys();
  const remove = useDeletePasskey();
  const rename = useRenamePasskey();

  // Array.isArray, not `?? []`. The nullish guard admits any TRUTHY non-array
  // -- a paged `{items: []}` envelope, or the HTML an SPA fallback serves for
  // an absent upstream -- straight into the iteration below.
  const rows = Array.isArray(passkeys.data) ? passkeys.data : [];

  async function onDelete(row: PasskeyCredential): Promise<void> {
    const label = row.name || "this passkey";
    const ok = await confirm({
      title: `Delete ${label}?`,
      message:
        "Anyone holding that authenticator will no longer be able to sign in with it. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(row.id);
      haptics.success();
      toast({ kind: "success", message: `${label} deleted.` });
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not delete that passkey.",
      });
    }
  }

  /**
   * Resolves true only when the row was actually renamed, so the row can keep
   * the editor open (with the text still in it) on failure rather than
   * discarding what the user typed.
   */
  async function onRename(
    row: PasskeyCredential,
    name: string,
  ): Promise<boolean> {
    try {
      await rename.mutateAsync({ id: row.id, name });
      haptics.success();
      toast({ kind: "success", message: `Renamed to ${name}.` });
      return true;
    } catch (error) {
      haptics.error();
      toast({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not rename that passkey.",
      });
      return false;
    }
  }

  return (
    <View style={{ gap: 12 }} testID="passkeys-section">
      <Text {...typeCap("body")} style={{ color: t.fg, fontWeight: "600" }}>
        Passkeys
      </Text>
      <Text {...typeCap("caption")} style={{ color: t.fgMuted, fontSize: 13 }}>
        These can sign in to your account without a password.
      </Text>

      <QueryStates
        query={passkeys}
        // Without `gate`, a query disabled because the app is offline falls
        // through to the empty state and tells the user their passkeys do not
        // exist. ActiveDevicesSection passes it for the same reason.
        gate={gate}
        isEmpty={rows.length === 0}
        empty={{
          title: "No passkeys registered",
          description:
            "Add one from the web dashboard to sign in without a password.",
        }}
      >
        <View style={{ gap: 8 }}>
          {rows.map((row) => (
            <PasskeyRow
              key={row.id}
              row={row}
              deleting={remove.isPending}
              renaming={rename.isPending}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))}
        </View>
      </QueryStates>

      {/* Enrollment is deliberately absent — see the module header. Offering a
          button that cannot complete a ceremony is worse than naming where it
          does work. */}
      <Text {...typeCap("caption")} style={{ color: t.fgMuted, fontSize: 12 }}>
        {`Add a passkey from the Moosewave web dashboard, under ${pathLabel([
          "Settings",
          "Security",
        ])}.`}
      </Text>
    </View>
  );
}

function PasskeyRow({
  row,
  deleting,
  renaming,
  onDelete,
  onRename,
}: {
  row: PasskeyCredential;
  deleting: boolean;
  renaming: boolean;
  onDelete: (row: PasskeyCredential) => void | Promise<void>;
  onRename: (row: PasskeyCredential, name: string) => Promise<boolean>;
}) {
  const { t } = useTheme();
  // `null` is "not editing" — distinct from "" (editing, field emptied), which
  // must disable Save rather than send a blank the server would silently
  // rewrite to the literal word "Passkey".
  const [draft, setDraft] = useState<string | null>(null);
  const current = row.name ?? "";
  const trimmed = (draft ?? "").trim();
  const canSave = trimmed !== "" && trimmed !== current && !renaming;

  async function commit(): Promise<void> {
    if (!canSave) return;
    if (await onRename(row, trimmed)) setDraft(null);
  }

  if (draft !== null) {
    return (
      <View style={{ gap: 8 }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          maxLength={MAX_NAME_LENGTH}
          returnKeyType="done"
          onSubmitEditing={() => void commit()}
          placeholder="Name this passkey"
          placeholderTextColor={t.fgSubtle}
          accessibilityLabel="Passkey name"
          accessibilityHint="Names this passkey so you can tell it apart from your others."
          {...typeCap("body")}
          style={{
            backgroundColor: t.bgSubtle,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 10,
            color: t.fg,
            paddingHorizontal: 12,
            paddingVertical: 9,
            // Size only: an explicit lineHeight on a TextInput mis-centres the
            // caret and clips descenders on Android (lib/typeScale.fontSizeFor).
            fontSize: fontSizeFor("body"),
            fontFamily: FONT.regular,
          }}
        />
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 4 }}>
          <RowAction
            label="Cancel"
            accessibilityLabel={`Cancel renaming ${current || "passkey"}`}
            onPress={() => setDraft(null)}
            disabled={renaming}
            t={t}
          />
          <RowAction
            label={renaming ? "Saving…" : "Save"}
            accessibilityLabel={`Save the new name for ${current || "passkey"}`}
            onPress={() => void commit()}
            disabled={!canSave}
            emphasis
            busy={renaming}
            t={t}
          />
        </View>
      </View>
    );
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <View style={{ flexShrink: 1 }}>
        <Text {...typeCap("body")} style={{ color: t.fg }}>
          {current || "Unnamed passkey"}
        </Text>
        <Text {...typeCap("caption")} style={{ color: t.fgMuted, fontSize: 12 }}>
          {lastUsedLabel(row)}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <RowAction
          label="Rename"
          accessibilityLabel={`Rename ${current || "passkey"}`}
          onPress={() => setDraft(current)}
          disabled={deleting || renaming}
          t={t}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${current || "passkey"}`}
          onPress={() => void onDelete(row)}
          disabled={deleting}
          style={{ padding: 8, minHeight: 44, justifyContent: "center" }}
        >
          {deleting ? (
            <ActivityIndicator />
          ) : (
            <Text {...typeCap("body")} style={{ color: t.danger }}>
              Delete
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

/**
 * A row-level text button. Static style object, never the
 * `({pressed}) => …` form — the function form silently drops layout under
 * NativeWind v4 (see apps/mobile/scripts/fix-pressable-style.mjs).
 */
function RowAction({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  emphasis,
  busy,
  t,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
  emphasis?: boolean;
  busy?: boolean;
  t: ThemeTokens;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, busy: Boolean(busy) }}
      onPress={onPress}
      disabled={disabled}
      style={{
        padding: 8,
        minHeight: 44,
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: t.accent,
          ...(emphasis
            ? { fontWeight: "600" as const, fontFamily: FONT.semibold }
            : {}),
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
