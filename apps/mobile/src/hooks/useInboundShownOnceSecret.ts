/**
 * hooks/useInboundShownOnceSecret.ts — the whole life of the signing secret
 * the inbound-webhooks screen shows exactly once.
 *
 * Extracted from app/(tabs)/inbound-webhooks.tsx by responsibility, the way
 * `useInboundUrlHandoff` was before it: the screen crossed its source budget
 * when it gained CREATE, and this is the one part of it that is neither list
 * state nor a confirm — it is a value with a lifetime.
 *
 * There are two secrets a create and a rotate produce and exactly one slot to
 * put them in, so the rules live together here rather than being re-derived at
 * three call sites:
 *
 *   - WHERE IT LIVES. `lib/revealOnceSecret`, process memory, one slot,
 *     self-expiring. Never disk, never the query cache, never a log line, and
 *     never held in this hook's own state either — only the ID is.
 *   - WHETHER IT MAY BE DRAWN. `lib/inboundSecretReveal`, which admits a
 *     just-created endpoint the list has not caught up with while still
 *     refusing a secret minted on the outbound webhooks screen, which shares
 *     the slot.
 *   - WHAT MAY BE SAID ABOUT IT. `lib/inboundEndpointAdmin`, keyed to how it
 *     was minted: a rotation has a 24-hour grace window and a create has no
 *     predecessor at all.
 *
 * `revision` is the handshake with WebhookSecretCard, which re-reads the stash
 * whenever it changes. Every transition bumps it, including dismissal, so the
 * card cannot keep rendering a value the stash no longer holds.
 */
import { useCallback, useState } from "react";

import {
  inboundSecretCardCopy,
  type InboundSecretCardCopy,
} from "@/lib/inboundEndpointAdmin";
import {
  forgetInboundSecretMint,
  inboundSecretCopyKind,
  noteInboundSecretMinted,
  shouldRevealInboundSecret,
} from "@/lib/inboundSecretReveal";
import { peekSecret, stashSecret } from "@/lib/revealOnceSecret";

export interface InboundShownOnceSecret {
  /** The endpoint the on-screen secret belongs to, or null. */
  endpointId: string | null;
  /** Bumped on every transition; the card re-reads the stash on it. */
  revision: number;
  /** Whether the card may be drawn against the endpoints currently loaded. */
  visible: boolean;
  /** Title / description / spoken label, in the words this mint has earned. */
  copy: InboundSecretCardCopy;
  /** A rotation landed: same ceremony, and it may promise the grace window. */
  onRotated: (endpointId: string, secret: string) => void;
  /** A create landed: no predecessor, so no grace window may be promised. */
  onCreated: (result: { endpointId: string; secret: string }) => void;
  /** Captured, or expired. Drops the value AND the note about it. */
  onDismiss: () => void;
}

export function useInboundShownOnceSecret(
  endpoints: readonly { id: string }[],
  graceHours: number,
): InboundShownOnceSecret {
  // Seeded FROM the stash so the card survives leaving the app to open a
  // password manager — the reason lib/revealOnceSecret exists at all.
  const [endpointId, setEndpointId] = useState<string | null>(
    () => peekSecret()?.id ?? null,
  );
  const [revision, setRevision] = useState(0);

  const accept = useCallback(
    (id: string, secret: string, kind: "create" | "rotate") => {
      // Note and stash BEFORE any state write: the secret is returned exactly
      // once, and a re-render between the two would be a window in which it
      // exists nowhere.
      noteInboundSecretMinted(id, kind);
      stashSecret(id, secret);
      setEndpointId(id);
      setRevision((n) => n + 1);
    },
    [],
  );

  const onRotated = useCallback(
    (id: string, secret: string) => accept(id, secret, "rotate"),
    [accept],
  );

  const onCreated = useCallback(
    (result: { endpointId: string; secret: string }) =>
      accept(result.endpointId, result.secret, "create"),
    [accept],
  );

  const onDismiss = useCallback(() => {
    forgetInboundSecretMint();
    setEndpointId(null);
    setRevision((n) => n + 1);
  }, []);

  // Not the FILTERED rows: a search that hides the endpoint must not hide the
  // once-only secret that belongs to it.
  const visible = shouldRevealInboundSecret(endpointId, endpoints);
  // Deliberately NOT memoised. The provenance it reads lives in module scope,
  // so the words can change while `endpointId` does not — rotating an endpoint
  // whose freshly-created secret is still on screen is exactly that, and it
  // must stop claiming "no predecessor" the moment one exists. A memo keyed on
  // the id would serve the stale sentence; one keyed on `revision` as well
  // reads as an unnecessary dependency to anyone (and to eslint) who cannot
  // see the module state. The function builds one small object literal.
  const copy = inboundSecretCardCopy(inboundSecretCopyKind(endpointId), graceHours);

  return {
    endpointId,
    revision,
    visible,
    copy,
    onRotated,
    onCreated,
    onDismiss,
  };
}
