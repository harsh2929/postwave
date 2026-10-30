/**
 * sequenceShare — what goes into the system share sheet for a sequence.
 *
 * Every empty and boundary state on this cluster ends with some form of "open
 * it on desktop", and the app offered no way to actually GET there: no share,
 * no copy, no link. A handoff affordance is the missing half of an instruction
 * to switch devices.
 *
 * Pure (no react-native reachable) so the copy and the URL construction are
 * unit-tested rather than assembled inline in a press handler. The URL comes
 * from @postwave/route-map, never from string concatenation here — the same
 * builder desktop and web use, so the three clients cannot drift on what a
 * sequence's canonical address is.
 */
import { buildUniversalLink } from "@postwave/route-map";

export interface SequenceShareInput {
  id?: string | null | undefined;
  name?: string | null | undefined;
  statusLabel?: string | null | undefined;
  stepCount?: number | undefined;
}

export interface SequenceShare {
  title: string;
  message: string;
  url: string;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the share payload, or null when there is nothing shareable.
 *
 * Returns null — rather than a link to a list — when the id is missing or
 * unsafe: `buildUniversalLink` rejects ids that are not safe resource ids, and
 * sharing a URL that resolves to the wrong thing is worse than not offering
 * the action at all. Callers hide the affordance on null.
 */
export function sequenceShare(input: SequenceShareInput): SequenceShare | null {
  const id = trimmed(input.id);
  if (!id) return null;
  const url = buildUniversalLink("sequence", id);
  if (!url) return null;

  const title = trimmed(input.name) || "Sequence";
  const status = trimmed(input.statusLabel);
  const steps =
    typeof input.stepCount === "number" && Number.isFinite(input.stepCount)
      ? Math.max(0, Math.floor(input.stepCount))
      : null;

  const facts = [status, steps === null ? "" : `${steps} step${steps === 1 ? "" : "s"}`]
    .filter(Boolean)
    .join(" · ");

  return {
    title,
    url,
    message: facts ? `${title}\n${facts}\n${url}` : `${title}\n${url}`,
  };
}
