/**
 * Archive / unarchive one subscriber (AUDIENCE#56 — SUB-009 soft delete).
 *
 *   PATCH /api/v1/subscribers/{id}/archive
 *   PATCH /api/v1/subscribers/{id}/unarchive
 *
 * BOTH REQUIRE OPTIMISTIC CONCURRENCY, and this is the whole reason the hook
 * is more than two lines. apps/api/internal/subscribers/soft_delete.go:200-215
 * calls `httpcache.ParseIfMatch` and answers **428 Precondition Required** when
 * the header is absent OR the wildcard `*` — so "just PATCH it" cannot work,
 * and neither can `If-Match: *`. The repo then compares the token by EXACT
 * string equality against the row's own `version`
 * (soft_delete.go:87 — `ifMatchToken != current.Version` → ErrPreconditionFailed
 * → 412), and `version` is a quoted strong ETag of the form
 * `"subscriber:<id>:v<updated_at_micros>"`.
 *
 * The good news, which the earlier notes on this finding missed: `version` is
 * declared on EVERY subscriber representation including list rows
 * (types.go:157 — "carried in every subscriber representation … so clients can
 * issue an exact If-Match without an extra detail round-trip"), so the token
 * the phone needs is already in hand. It is passed in verbatim — quotes
 * included — because stripping them would fail the equality check.
 *
 * A 412 is therefore a REAL, expected outcome (someone edited the contact from
 * another surface since this screen loaded it) and is reported as exactly that
 * rather than as a generic failure.
 *
 * Scope: `apikeys.RequireScope(ScopeWriteSubscribers)` — a read-only scope on
 * the session path per apikeys/middleware.go's `readOnlyScopes` allowlist?  No:
 * write:subscribers is admin-tier BUT is listed in `editorWriteScopes`, so on a
 * session it admits owner, admin AND editor. The callers gate on `editor`,
 * matching the rest of the profile's write surface.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { subscriberMutationInvalidationKeys } from "@/lib/subscriberQueryKeys";

/** 428 — the header was missing entirely. A client bug, never a user's. */
export const PRECONDITION_REQUIRED = 428;
/** 412 — the row moved under us. */
export const PRECONDITION_FAILED = 412;

export interface ArchiveInput {
  id: string;
  /** The row's `version`, VERBATIM including its surrounding quotes. */
  version: string;
}

export class MissingVersionError extends Error {
  constructor() {
    super(
      "This contact was loaded without a revision token, so archiving can't be done safely. Pull to refresh and try again.",
    );
    this.name = "MissingVersionError";
  }
}

/**
 * The one sentence to show for a failed archive/unarchive.
 *
 * Exported and pure so the wording for the concurrency cases is testable
 * without a QueryClient.
 */
export function archiveFailureMessage(
  status: number,
  archiving: boolean,
  fallback: string,
): string {
  const verb = archiving ? "archive" : "restore";
  if (status === PRECONDITION_FAILED) {
    return `This contact changed somewhere else while you were looking at it, so it wasn't ${archiving ? "archived" : "restored"}. Pull to refresh and try again.`;
  }
  if (status === PRECONDITION_REQUIRED) {
    return `Couldn't ${verb} this contact: its revision token is missing. Pull to refresh and try again.`;
  }
  if (status === 403) {
    return `You don't have permission to ${verb} contacts.`;
  }
  if (status === 404) {
    return "This contact no longer exists.";
  }
  return fallback;
}

function useArchiveMutation(archiving: boolean) {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async ({ id, version }: ArchiveInput) => {
      // Fail here rather than sending a request the server is required to
      // reject with 428 — a round trip that can only ever fail is worse than
      // a local error that names the actual problem.
      if (!version.trim()) throw new MissingVersionError();
      const res = await rawRequest<unknown>(
        "PATCH",
        `/api/v1/subscribers/${encodeURIComponent(id)}/${archiving ? "archive" : "unarchive"}`,
        undefined,
        { headers: { "If-Match": version } },
      );
      if (res.error) {
        const err = new Error(res.error.message) as Error & { status?: number };
        err.status = res.error.status;
        throw err;
      }
      return res.data;
    },
    onSuccess: async (_data, variables) => {
      if (!tenantId) return;
      await Promise.all(
        subscriberMutationInvalidationKeys(tenantId, variables.id).map((key) =>
          queryClient.invalidateQueries({ queryKey: key }),
        ),
      );
    },
  });
}

export function useArchiveSubscriber() {
  return useArchiveMutation(true);
}

export function useUnarchiveSubscriber() {
  return useArchiveMutation(false);
}
