/**
 * InboundEndpointAdminActions — RENAME and DELETE for one endpoint, as a slim
 * strip under its card.
 *
 * Both verbs were desktop-only: the phone could disable an endpoint but never
 * remove it, and could not fix a label typed into the create dialog months
 * ago. PATCH and DELETE /api/v1/inbound-webhooks/{id} are both admin
 * (routeauth manifest; handlers.go:156,158).
 *
 * DELETE IS NOT DISABLE, AND THE CONFIRM SAYS SO. `Repo.Delete` (repo.go:407)
 * tombstones the row: ingest is revoked at once, every secret column is
 * overwritten with the destroyed sentinel, and migration 1793's retention pass
 * only purges the row physically once no retained event and no action intent
 * remain and 24 hours have passed. So "delete" simultaneously means "the URL
 * and its secrets are gone for good" AND "the evidence is not gone yet", and
 * an operator reaching for it to achieve either one needs to be told the
 * other. The sentence is lib/inboundEndpointAdmin's, gated behind the typed
 * phrase this screen already uses for rotation.
 *
 * NEITHER VERB IS OFFERED OFFLINE. Neither can be queued honestly: a delete
 * that fires on reconnect shreds an endpoint's signing material at a moment
 * the operator did not choose, and a rename that fires later can silently
 * overwrite a name someone else fixed in between. The controls are disabled
 * with the reason spoken, not hidden.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { InboundEndpointNameSheet } from "@/components/inbound-webhooks/InboundEndpointNameSheet";
import { isInboundEndpointGone } from "@/api/inboundEndpointAdmin";
import { useInboundEndpointAdminActions } from "@/hooks/useInboundEndpointAdmin";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import {
  inboundEndpointDeleteConfirmCopy,
  inboundEndpointLabel,
} from "@/lib/inboundEndpointAdmin";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface InboundEndpointAdminActionsProps {
  endpoint: { id: string; name: string; slug: string };
}

export function InboundEndpointAdminActions({
  endpoint,
}: InboundEndpointAdminActionsProps) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const actions = useInboundEndpointAdminActions();
  const [renaming, setRenaming] = useState(false);

  const label = inboundEndpointLabel(endpoint);
  const offline = !gate.enabled;
  const busy = actions.rename.isPending || actions.remove.isPending;
  const blocked = offline || busy;

  if (!canAccessMinimumRole("admin", gate.effectiveRole)) return null;

  const rename = (name: string) => {
    if (actions.rename.isPending) return;
    actions.rename.mutate(
      { id: endpoint.id, name },
      {
        onSuccess: (saved) => {
          setRenaming(false);
          toast({ kind: "success", message: `Renamed to “${saved}”.` });
        },
        onError: (err) => {
          toast({
            kind: "error",
            message:
              errorPresentation(err).message || "Couldn't rename the endpoint.",
          });
        },
      },
    );
  };

  const remove = async () => {
    if (blocked) return;
    const ok = await confirm({
      ...inboundEndpointDeleteConfirmCopy(endpoint),
      destructive: true,
    });
    if (!ok) return;
    actions.remove.mutate(endpoint.id, {
      onSuccess: () => {
        toast({ kind: "success", message: `${label} deleted.` });
      },
      onError: (err) => {
        if (isInboundEndpointGone(err)) {
          // The tombstone is already set — by another operator, or by this
          // device before a lost response. The endpoint is gone either way,
          // so this reads as done-by-someone-else, not as a failure. The hook
          // refreshes the list on this path too.
          toast({
            kind: "warning",
            message: "That endpoint was already deleted. Pull to refresh.",
          });
          return;
        }
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || "Couldn't delete the endpoint.",
        });
      },
    });
  };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        marginTop: -6,
        marginBottom: 14,
        marginHorizontal: 8,
      }}
    >
      {offline ? (
        <Text
          {...typeCap("caption")}
          style={{
            flexShrink: 1,
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Offline — renaming and deleting need a connection.
        </Text>
      ) : null}
      <RowButton
        label="Rename"
        // Every row carries these two controls, so a bare "Delete" would be
        // one of a dozen identically-named buttons to a screen reader.
        accessibilityLabel={`Rename ${label}`}
        disabled={blocked}
        disabledReason={
          offline
            ? "Unavailable offline; renaming needs a connection."
            : "A change to this endpoint is already in flight."
        }
        onPress={() => setRenaming(true)}
      />
      <RowButton
        label="Delete"
        accessibilityLabel={`Delete ${label}`}
        accessibilityHint="Asks you to type DELETE to confirm. Ingest stops immediately and the signing secrets are shredded."
        danger
        disabled={blocked}
        disabledReason={
          offline
            ? "Unavailable offline; deleting needs a connection."
            : "A change to this endpoint is already in flight."
        }
        onPress={() => void remove()}
      />
      <InboundEndpointNameSheet
        visible={renaming}
        mode="rename"
        initialName={endpoint.name}
        endpointLabel={label}
        submitting={actions.rename.isPending}
        offline={offline}
        onClose={() => {
          if (!actions.rename.isPending) setRenaming(false);
        }}
        onSubmit={rename}
      />
    </View>
  );
}

/**
 * A compact row control. Local rather than the shared ActionButton because
 * each of these needs its OWN spoken label (the endpoint's name) and a spoken
 * reason when it is dimmed; the shared one speaks its visible text.
 */
function RowButton({
  label,
  accessibilityLabel,
  accessibilityHint,
  danger,
  disabled,
  disabledReason,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  accessibilityHint?: string | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const hint = disabled ? disabledReason : accessibilityHint;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={{
        backgroundColor: t.bgSubtle,
        borderColor: danger ? t.danger : t.border,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: danger ? t.danger : t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
