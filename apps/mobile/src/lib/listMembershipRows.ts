/**
 * listMembershipRows — the pure half of editing membership FROM THE LIST:
 * candidate parsing, the already-a-member merge, and the copy both writes
 * put on screen. react-native-free, so node vitest covers every decision.
 *
 * Server truth, read off apps/api/internal/lists/membership_write.go:
 *
 *   POST /api/v1/lists/{id}/subscribers   body {"subscriber_ids": [...]}
 *        → 200 {"added": n, "skipped": n}
 *        added   = rows newly inserted OR revived from a soft-delete.
 *        skipped = ids that were ALREADY active members, ids that don't
 *                  resolve to a subscriber in this tenant, and bigint-shaped
 *                  ids (subscribers have no bigint↔uuid map, so an integer id
 *                  is accepted and can never match). The server does not break
 *                  that down further, so neither does the copy here.
 *        At most 1000 ids per request; an id that is neither a uuid nor an
 *        integer 400s the WHOLE batch, which is why a candidate row without a
 *        uuid is never selectable.
 *
 *   DELETE /api/v1/lists/{id}/subscribers/{sub_id} → 204
 *        SOFT-DELETES the membership row (sets removed_at). The subscriber
 *        record, their subscription status and their other lists are all
 *        untouched — this DETACHES someone from one list, it does not
 *        unsubscribe them, and they can be added again. 204 is returned even
 *        when nothing was removed (removing a non-member is a documented
 *        no-op), and a membership still claimed by another source owner
 *        (a form, an import) survives the call — so the refreshed roster,
 *        never the 204, is what says who is on the list now.
 */

/** membership_write.go maxMembershipBatch. */
export const LIST_MEMBER_ADD_MAX = 1000;

/**
 * The sentence shown when the whole membership-editing surface is withheld
 * from a role. Both routes are editor-floor in the routeauth manifest, and a
 * missing affordance for a role gets one caption, not a disabled button.
 */
export const LIST_MEMBERSHIP_ROLE_CAPTION =
  "Adding or removing members needs the editor role or above.";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The only id shape the membership writes can ever resolve. */
export function isSubscriberUuid(id: unknown): boolean {
  return typeof id === "string" && UUID_RE.test(id.trim());
}

// ── candidate search ────────────────────────────────────────────────────────

export interface ListCandidate {
  /** Present only when the server sent a uuid — see the file header. */
  id: string | null;
  email: string;
  status: string;
  /** Display name when the payload carried one; "" when it did not. */
  name: string;
}

export interface ListCandidatePage {
  items: ListCandidate[];
  total: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function displayName(row: Record<string, unknown>): string {
  const full = str(row.full_name).trim() || str(row.display_name).trim();
  if (full) return full;
  const parts = [str(row.first_name).trim(), str(row.last_name).trim()].filter(
    Boolean,
  );
  return parts.join(" ");
}

/**
 * GET /api/v1/subscribers → subscribers.Page {items, total, page, per_page}.
 * A row without an email cannot be shown or spoken, so it is dropped; a row
 * without a uuid id is KEPT but carries `id: null`, because hiding it would
 * answer "nobody by that name" when the truth is "found, but not addable".
 */
export function parseCandidatePage(res: unknown): ListCandidatePage {
  const row = (res ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(row.items) ? row.items : [];
  const items: ListCandidate[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const email = str(c.email).trim();
    if (!email) continue;
    items.push({
      id: isSubscriberUuid(c.id) ? String(c.id).trim() : null,
      email,
      status: str(c.status),
      name: displayName(c),
    });
  }
  return {
    items,
    total:
      typeof row.total === "number" && Number.isFinite(row.total)
        ? row.total
        : items.length,
  };
}

/**
 * The subscriber ids that are ALREADY on this list, from a members page
 * fetched with the same query. Used to mark candidates rather than to claim
 * completeness: the members read matches on email substring while the
 * candidate read also matches names, so this set is exact for an email-shaped
 * query and a lower bound otherwise. That is why the add still reports the
 * server's `skipped` count verbatim instead of promising every selected row
 * was new.
 */
export function memberIdSet(pages: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const page of pages) {
    const row = (page ?? {}) as Record<string, unknown>;
    const items = Array.isArray(row.items) ? row.items : [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const id = (raw as Record<string, unknown>).id;
      if (isSubscriberUuid(id)) ids.add(String(id).trim());
    }
  }
  return ids;
}

export type CandidateState = "addable" | "member" | "unavailable";

export interface CandidateRow extends ListCandidate {
  state: CandidateState;
}

/**
 * Merge the candidate page with what is known about membership.
 *
 * Members and unusable rows sort to the BOTTOM (they are not actionable) with
 * the catalogue order preserved inside each group, matching the person-side
 * picker (components/subscriber/AddToListModal).
 */
export function buildCandidateRows(
  candidates: readonly ListCandidate[],
  memberIds: ReadonlySet<string>,
): CandidateRow[] {
  const rows: CandidateRow[] = candidates.map((c) => ({
    ...c,
    state:
      c.id === null
        ? ("unavailable" as const)
        : memberIds.has(c.id)
          ? ("member" as const)
          : ("addable" as const),
  }));
  return [
    ...rows.filter((r) => r.state === "addable"),
    ...rows.filter((r) => r.state !== "addable"),
  ];
}

/** The trailing word on a candidate row. */
export function candidateTrailingLabel(
  row: CandidateRow,
  selected: boolean,
): string {
  if (row.state === "member") return "On list";
  if (row.state === "unavailable") return "No id";
  return selected ? "Selected" : "Add";
}

/**
 * Ids a submit may send: selected, still addable, deduped, and capped at the
 * server's batch limit so the request cannot 400 on `too_many_subscriber_ids`.
 * `capped` is returned so the sheet can SAY the ask was trimmed rather than
 * silently sending a subset.
 */
export function addableSelection(
  rows: readonly CandidateRow[],
  selected: ReadonlySet<string>,
): { ids: string[]; emails: string[]; capped: boolean } {
  const picked = new Map<string, string>();
  for (const row of rows) {
    if (row.state !== "addable" || row.id === null) continue;
    if (!selected.has(row.id)) continue;
    picked.set(row.id, row.email);
  }
  const all = [...picked.keys()];
  const ids = all.slice(0, LIST_MEMBER_ADD_MAX);
  return {
    ids,
    // The confirm names the people it is about, so the addresses travel with
    // the ids and are trimmed by the same cap.
    emails: ids.map((id) => picked.get(id) ?? id),
    capped: all.length > LIST_MEMBER_ADD_MAX,
  };
}

// ── write results ───────────────────────────────────────────────────────────

export interface AddMembersResult {
  added: number;
  skipped: number;
}

/**
 * Parse {added, skipped}. Returns null when the body carried neither as a
 * number: a 200 means the write landed, but inventing a count for it would be
 * a fabricated number, and the copy has a branch for exactly that.
 */
export function parseAddMembersResult(res: unknown): AddMembersResult | null {
  const row = (res ?? {}) as Record<string, unknown>;
  const added = row.added;
  const skipped = row.skipped;
  if (typeof added !== "number" || !Number.isFinite(added)) return null;
  if (typeof skipped !== "number" || !Number.isFinite(skipped)) return null;
  return { added: Math.trunc(added), skipped: Math.trunc(skipped) };
}

export interface MembershipToast {
  kind: "success" | "info";
  message: string;
}

const s = (n: number): string => (n === 1 ? "" : "s");

/**
 * Copy for the toast after the add, reporting `{added, skipped}` EXACTLY as
 * the server returned them — never "Added 5" when four of the five were
 * skipped. Mirrors the desktop anchor (components/lists/tabs/members-copy.ts)
 * so the same write reads the same on both surfaces.
 */
export function addMembersToastCopy(
  listName: string,
  result: AddMembersResult | null,
): MembershipToast {
  if (result === null) {
    // The server accepted the write but told us no counts. The refreshed
    // roster is the record; a made-up number would not be.
    return { kind: "info", message: `Updated “${listName}”.` };
  }
  const { added, skipped } = result;
  if (added === 0) {
    return {
      kind: "info",
      message:
        skipped === 0
          ? `Nothing to add to “${listName}”.`
          : `No one added: all ${skipped} were skipped (already on this list, or not found).`,
    };
  }
  if (skipped === 0) {
    return {
      kind: "success",
      message: `Added ${added} subscriber${s(added)} to “${listName}”.`,
    };
  }
  return {
    kind: "success",
    message: `Added ${added} of ${added + skipped} to “${listName}” — ${skipped} skipped (already on this list, or not found).`,
  };
}

export interface MembershipConfirmCopy {
  title: string;
  message: string;
  confirmLabel: string;
  consequence: string;
}

/** Kept for the remove confirm's own call site; the shape is shared. */
export type RemoveConfirmCopy = MembershipConfirmCopy;

/**
 * The add confirm NAMES the list and, while the selection is small enough to
 * read on a phone, every person in it. Adding people to a list changes who
 * receives mail, so the last step before the write says whose mail it is.
 */
export function addMembersConfirmCopy(
  listName: string,
  emails: readonly string[],
): MembershipConfirmCopy {
  const who =
    emails.length <= 3
      ? emails.join(", ")
      : `${emails.length} subscribers (${emails.slice(0, 2).join(", ")} and ${emails.length - 2} more)`;
  return {
    title: emails.length === 1 ? "Add to this list?" : "Add these people?",
    message: `${who} will be added to “${listName}”.`,
    confirmLabel: emails.length === 1 ? "Add" : `Add ${emails.length}`,
    consequence:
      "They start receiving what this list is sent. Anyone already on it is skipped.",
  };
}

/**
 * The remove confirm NAMES the person and the list, and says plainly what
 * removal does — the handler detaches the membership row and touches nothing
 * else, so "unsubscribed" would be the wrong word for it.
 */
export function removeMemberConfirmCopy(
  listName: string,
  email: string,
): MembershipConfirmCopy {
  return {
    title: "Remove from this list?",
    message: `${email} will be taken off “${listName}”.`,
    confirmLabel: "Remove",
    consequence:
      "They stay a subscriber and keep their other lists — this ends their membership of this one, and they stop receiving what it is sent. You can add them back.",
  };
}
