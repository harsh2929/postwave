/**
 * InboundEndpointCreateControl — the "New" control in the inbound-webhooks
 * header, plus the sheet behind it.
 *
 * WHY MOBILE CREATES ENDPOINTS NOW. The screen this mounts on said in prose
 * that "the desktop app remains the primary CREATOR", and the register agreed:
 * mobile could manage endpoints it already had and mint none. But the moment
 * an operator needs one is the moment they are standing in someone else's
 * admin console with a "Webhook URL" field open — which is exactly the moment
 * they do not have a laptop. POST /api/v1/inbound-webhooks is admin
 * (routeauth manifest; handlers.go:154) and returns the endpoint plus its
 * signing secret in one 201.
 *
 * THE SECRET IS THE WHOLE DESIGN. It is returned exactly once
 * (repo.go CreateWithOptions) and stored only as ciphertext, so this component
 * hands it straight to the screen's `revealOnceSecret` stash — process memory,
 * never disk, never the query cache, never a log line — where WebhookSecretCard
 * shows it with a copy affordance, blocks screenshots while it is up, and
 * refuses to be dismissed until it has actually been captured. This component
 * keeps NO copy of it: `onSuccess` fires, the value is handed on in that same
 * tick, and nothing here retains a reference — it is never held in state, in a
 * ref, or in a toast string.
 *
 * The control is withheld below admin rather than shown and refused: the route
 * is admin-only, so a member pressing it could only ever collect a 403.
 */
import { useRef, useState } from "react";
import { View } from "react-native";

import { useToast } from "@/components/Toast";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { InboundEndpointNameSheet } from "@/components/inbound-webhooks/InboundEndpointNameSheet";
import { useInboundEndpointAdminActions } from "@/hooks/useInboundEndpointAdmin";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

export interface InboundEndpointCreateControlProps {
  /**
   * Handed the one-time secret the instant it lands. The caller is expected
   * to stash it (lib/revealOnceSecret) before anything else can unmount this
   * tree — the server will not produce it again.
   */
  onCreated: (result: { endpointId: string; secret: string }) => void;
  /**
   * True while a shown-once secret is still on screen. The stash holds
   * exactly ONE secret process-wide and `stashSecret` replaces it, so a
   * second create would silently destroy a value the operator has not
   * captured yet. Desktop refuses the same way (pages/InboundWebhooks.tsx
   * `secretOrRequestBusy`), with a message rather than a dead control.
   */
  secretShown?: boolean | undefined;
}

export function InboundEndpointCreateControl({
  onCreated,
  secretShown = false,
}: InboundEndpointCreateControlProps) {
  const gate = useOnlineQueryGate();
  const { toast } = useToast();
  const actions = useInboundEndpointAdminActions();
  const [open, setOpen] = useState(false);
  // Returns VoiceOver focus to "New" when the sheet closes.
  const buttonRef = useRef<View | null>(null);

  if (!canAccessMinimumRole("admin", gate.effectiveRole)) return null;

  const submit = (name: string) => {
    if (actions.create.isPending) return;
    actions.create.mutate(name, {
      onSuccess: (created) => {
        // Hand the secret on FIRST: the sheet is about to unmount and this is
        // the only moment the value exists anywhere in the app.
        onCreated({ endpointId: created.endpointId, secret: created.secret });
        setOpen(false);
        toast({
          kind: "success",
          message: "Endpoint created. Save the signing secret now.",
        });
      },
      onError: (err) => {
        toast({
          kind: "error",
          message:
            errorPresentation(err).message || "Couldn't create the endpoint.",
        });
      },
    });
  };

  return (
    <>
      <ActionButton
        label="New"
        primary
        onPress={() => {
          if (secretShown) {
            toast({
              kind: "warning",
              message:
                "Save or dismiss the signing secret on screen first — it is only shown once, and a new endpoint would replace it.",
            });
            return;
          }
          setOpen(true);
        }}
        disabled={actions.create.isPending}
        buttonRef={buttonRef}
      />
      <InboundEndpointNameSheet
        visible={open}
        mode="create"
        submitting={actions.create.isPending}
        offline={!gate.enabled}
        onClose={() => {
          if (!actions.create.isPending) setOpen(false);
        }}
        onSubmit={submit}
        returnFocusRef={buttonRef}
      />
    </>
  );
}
