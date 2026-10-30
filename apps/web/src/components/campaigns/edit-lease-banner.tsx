"use client";

import type { EditLeaseHolder } from "@/lib/use-edit-lease";

/**
 * Tells someone another person is editing this campaign, before they start.
 *
 * The whole value of a lease is arriving BEFORE the work: a 409 after someone
 * has rewritten a subject line has already cost them the rewrite. So this is
 * shown at the top of the editor, not raised as a toast on save.
 *
 * It does NOT disable the fields. The lease is advisory, the server is the
 * enforcement, and a read-only editor would be a worse product for a guarantee
 * the lease does not make — the holder may release it a second later, and
 * anyone locked out of even scrolling their own campaign would rightly complain.
 */
export function EditLeaseBanner({ holder }: { holder: EditLeaseHolder | null }) {
  if (!holder) return null;

  // "Someone else" is what this said before the server started returning the
  // holder. It is not actionable — the first thing a person does with it is get
  // up and ask around, which is the work the lease exists to save.
  const who = holder.label?.trim() || "Another editor";
  const since = formatSince(holder.since);

  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <p className="font-medium">
        {who} is editing this campaign{since}.
      </p>
      <p className="mt-1 opacity-90">
        You can look around, but saving will be refused until they finish. Their
        editing session releases automatically if they stop.
      </p>
    </div>
  );
}

/**
 * " since 14:32" — a wall-clock time rather than "3 minutes ago".
 *
 * A relative age has to keep re-rendering to stay true, and a stale one is
 * actively misleading here: "editing since 2 minutes ago" that has not updated
 * for ten is worse than no figure. A clock time is correct whenever it is read.
 */
function formatSince(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return ` since ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
