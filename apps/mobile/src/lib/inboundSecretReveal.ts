/**
 * lib/inboundSecretReveal.ts — who is allowed to see the shown-once inbound
 * signing secret, and which sentence may be said about it.
 *
 * TWO DEFECTS THIS EXISTS TO CLOSE, both introduced the moment the phone
 * gained CREATE. Before that, every secret on this screen came from a ROTATE,
 * so the endpoint it belonged to was already in the list and had already had a
 * predecessor secret. Neither is true of a create.
 *
 * 1. THE CARD WOULD NOT RENDER AT ALL. The screen gated the reveal on list
 *    membership (`endpoints.some(row => row.id === secretForId)`) to refuse a
 *    secret minted on the OUTBOUND surface, which shares the one process-memory
 *    stash. A just-created endpoint is not in that list: the create invalidates
 *    the list query and the refetch lands some milliseconds later — or never,
 *    if the device drops or the server answers 500. The server returns the
 *    secret exactly once, so "the list has not caught up" must not be able to
 *    swallow it.
 *
 * 2. IT WOULD HAVE PROMISED A GRACE WINDOW THAT DOES NOT EXIST. The kind lived
 *    in component state that defaulted to "rotate", so a created secret still
 *    on screen after the screen remounted (tab away and back, inside the
 *    stash's 10-minute TTL) would be described with "the previous secret keeps
 *    verifying for 24 hours" — about an endpoint that has no previous secret
 *    and is verifying nothing yet.
 *
 * THE FIX IS A NOTE, NOT A COPY OF THE SECRET. Only an id and how it was
 * minted are held here — never the secret, which stays in
 * `lib/revealOnceSecret` and only there. The note lives in module scope
 * deliberately: that is the SAME lifetime as the stash it describes, so it
 * survives exactly the unmounts the stash was built to survive, and dies with
 * the process exactly as the stash does. Nothing here touches SecureStore,
 * AsyncStorage, the query cache or a log line.
 *
 * MINTED-HERE WINS UNTIL DISMISSED. Once this process has minted a secret for
 * an id, the reveal stops asking the list anything at all — not while a refetch
 * is in flight, not if the refetch fails, not if the row is later removed. A
 * value the server will never produce again does not get taken off screen by a
 * background query; the operator dismisses it, through the card's own capture
 * ceremony, or the stash expires.
 *
 * No react-native / expo import, so the rules are unit-testable in node.
 */
import type { InboundSecretKind } from "./inboundEndpointAdmin";

/** The id whose secret THIS process minted, and how. Never the secret. */
let minted: { id: string; kind: InboundSecretKind } | null = null;

/**
 * Record that a create or a rotate just produced the secret now in the stash.
 * Call it immediately before `stashSecret`, with the same id.
 */
export function noteInboundSecretMinted(
  id: string,
  kind: InboundSecretKind,
): void {
  const endpointId = typeof id === "string" ? id.trim() : "";
  // A blank id could never match a row, so a note under one would silently
  // grant nothing while looking like it granted something.
  minted = endpointId ? { id: endpointId, kind } : null;
}

/** Drop the note. Paired with the operator dismissing the card. */
export function forgetInboundSecretMint(): void {
  minted = null;
}

/**
 * How the secret for `id` was minted, or null when this process did not mint
 * it — the outbound surface stashes secrets too and notes nothing.
 */
export function inboundSecretMintKind(
  id: string | null,
): InboundSecretKind | null {
  if (!id || !minted || minted.id !== id) return null;
  return minted.kind;
}

/**
 * Which sentence the card may say. The fallback is the CREATE copy on purpose:
 * it claims strictly less (no grace window), so an unknown provenance
 * under-promises instead of making a reassurance the server may not honour.
 */
export function inboundSecretCopyKind(id: string | null): InboundSecretKind {
  return inboundSecretMintKind(id) ?? "create";
}

/**
 * Whether the shown-once card may be rendered for `secretForId`.
 *
 * `Array.isArray`, not `?? []`: a restored persisted query cache written by an
 * older response shape hands this a truthy `{}` or `{items: []}`, which a
 * nullish guard passes straight through to `.some`.
 */
export function shouldRevealInboundSecret(
  secretForId: string | null,
  endpoints: readonly { id: string }[] | null | undefined,
): boolean {
  if (!secretForId) return false;
  if (inboundSecretMintKind(secretForId) !== null) return true;
  const rows = Array.isArray(endpoints) ? endpoints : [];
  return rows.some((row) => row?.id === secretForId);
}

/** Test seam: forget the note between cases. */
export function __resetInboundSecretMintForTests(): void {
  minted = null;
}
