/**
 * hooks/useOutboundKeyRotation.ts — the rotate ceremony for an outbound
 * webhook's signing key.
 *
 * Split out of `OutboundWebhooksSection` so the section could gain rotation
 * without growing past its size budget, and because the flow is genuinely a
 * unit: confirm with the consequence → call → branch on WHICH kind of material
 * came back → hand an HMAC secret to the reveal-once stash, or say plainly
 * that an asymmetric public key needs no ceremony.
 *
 * That branch is the part worth isolating. `POST /{id}/rotate-secret` returns
 * `signing_secret` for hmac_sha256 and `public_key_pem` for ecdsa_p256 /
 * ed25519 (outbound_webhooks.CreateResponse), and treating the second as a
 * secret would put a non-secret behind a capture-then-dismiss gate while
 * treating the first as public would lose it forever.
 */
import { useCallback, useState } from "react";

import {
  OUTBOUND_ROTATION_GRACE_HOURS,
  rotateOutboundWebhookSecret,
} from "@/api/outboundWebhooks";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { stashSecret } from "@/lib/revealOnceSecret";

/**
 * The grace window is the fact that makes this safe to do from a phone, so it
 * leads — without it an operator would reasonably assume every receiver breaks
 * the instant they tap.
 */
export const ROTATE_CONSEQUENCE = `Fresh signing material is minted now. The current key keeps working for ${OUTBOUND_ROTATION_GRACE_HOURS} hours — deliveries are signed with BOTH during the grace window — so receivers do not break the moment you tap. After that, anything still verifying with the old key will start rejecting deliveries.`;

/** The minimum a caller must know about the endpoint being rotated. */
export interface RotatableWebhook {
  id: string;
  url: string;
  description?: string | undefined;
}

export interface OutboundKeyRotation {
  /** The endpoint whose rotate is in flight, or null. */
  rotatingId: string | null;
  rotate: (webhook: RotatableWebhook) => Promise<void>;
}

export function useOutboundKeyRotation(options: {
  /** Called with the webhook id when a once-only secret was stashed. */
  onSecretRevealed: (webhookId: string) => void;
  /** Called after any successful rotation so the list can refetch. */
  onRotated: () => void;
}): OutboundKeyRotation {
  const confirm = useConfirm();
  const { toast } = useToast();
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const { onSecretRevealed, onRotated } = options;

  const rotate = useCallback(
    async (webhook: RotatableWebhook) => {
      const label = webhook.description?.trim() || webhook.url;
      const ok = await confirm({
        title: `Rotate the signing key for ${label}?`,
        message: ROTATE_CONSEQUENCE,
        confirmLabel: "Rotate",
        destructive: true,
        confirmPhrase: "ROTATE",
      });
      if (!ok) return;
      setRotatingId(webhook.id);
      try {
        const result = await rotateOutboundWebhookSecret(webhook.id);
        if (result.signingSecret) {
          // HMAC: unrecoverable, so it goes through the same
          // capture-then-dismiss ceremony a create does. Stashed BEFORE the
          // caller can re-render anything out from under it.
          stashSecret(result.webhookId, result.signingSecret);
          onSecretRevealed(result.webhookId);
          toast({
            kind: "success",
            message: "Key rotated. Save the new secret.",
          });
        } else {
          // Asymmetric: the new material is a PUBLIC key. Every later list
          // read returns it (`Webhook.signing_public_key`), so no ceremony
          // and no alarm — claiming otherwise would be theatre.
          toast({
            kind: "success",
            message:
              "Key rotated. This endpoint signs asymmetrically, so the new public key stays readable on the endpoint — nothing to save here.",
          });
        }
        onRotated();
      } catch (err) {
        toast({
          kind: "error",
          message:
            err instanceof Error && err.message
              ? err.message
              : "Couldn't rotate the key.",
        });
      } finally {
        setRotatingId(null);
      }
    },
    [confirm, onRotated, onSecretRevealed, toast],
  );

  return { rotatingId, rotate };
}
