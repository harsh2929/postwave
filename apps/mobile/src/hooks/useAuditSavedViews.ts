/**
 * hooks/useAuditSavedViews.ts — named filter sets for the audit log.
 *
 * Wire contract, read off apps/api/internal/server/audit_operations.go:43-46
 * and apps/api/internal/handlers/audit_extras.go — NOT off openapi.json:
 *
 *   GET    /api/v1/audit/saved-views        → { views: AuditSavedView[] }
 *   POST   /api/v1/audit/saved-views        → 201, a BARE view (not wrapped)
 *   DELETE /api/v1/audit/saved-views/{id}   → { ok: true }, or 404 not_found
 *
 * READING IS A SCOPE; WRITING IS ALSO A ROLE. All four routes are mounted with
 * `gates.read` = `apikeys.RequireScope(apikeys.ScopeAuditRead)` — the same gate
 * as GET /api/v1/audit itself — and an earlier revision of this comment
 * concluded from that alone that "anyone who can read the log can name a view
 * of it". THAT WAS WRONG, and the screen it justified offered a Save button
 * that could only 403.
 *
 * apps/api authorises TWICE. `routeauth.Middleware` is applied to the whole
 * authenticated group (server/authenticated_route_stack.go:38, wired at
 * main.go:2372) and independently enforces internal/routeauth/manifest.json,
 * whose rows read `session_minimum_role: viewer` for the GET and `admin` for
 * POST / PATCH / DELETE — all four `"review_status": "reviewed"`, so it is
 * deliberate policy. The effective floor is the STRICTER of the two gates.
 *
 * So the LIST below stays keyed off `hasAuditReadScope`, and the WRITE
 * affordances are gated separately by `lib/auditSavedViewPolicy`, which carries
 * the full trace (including the different api-key branch).
 *
 * THE 404 ON DELETE IS LOAD-BEARING. audit_extras.go:341 documents that an
 * earlier revision returned 200 unconditionally, and the frontend then
 * optimistically cleared its dropdown — leaving the operator believing they
 * had deleted a view that was gone already or never theirs. The mutation
 * below surfaces that distinction: a 404 still refreshes the list (the row
 * really is not there) but reports "already deleted", not "deleted".
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { sortSavedViews, type AuditSavedView } from "@/lib/auditViews";

export type { AuditSavedView } from "@/lib/auditViews";

/** Tolerate `{views}`, a bare array, and null — the cache is persisted. */
export function normalizeSavedViews(res: unknown): AuditSavedView[] {
  const raw = Array.isArray(res)
    ? res
    : ((res as { views?: unknown } | null)?.views ?? []);
  if (!Array.isArray(raw)) return [];
  const rows: AuditSavedView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const view = entry as Partial<AuditSavedView>;
    if (typeof view.id !== "string" || !view.id) continue;
    rows.push({
      id: view.id,
      name: typeof view.name === "string" && view.name ? view.name : "Untitled",
      ...(typeof view.description === "string"
        ? { description: view.description }
        : {}),
      filters:
        view.filters && typeof view.filters === "object"
          ? (view.filters as Record<string, unknown>)
          : {},
      ...(typeof view.createdAt === "string" ? { createdAt: view.createdAt } : {}),
      ...(typeof view.updatedAt === "string" ? { updatedAt: view.updatedAt } : {}),
    });
  }
  return sortSavedViews(rows);
}

function savedViewsKey(tenantId: string | null | undefined) {
  return ["audit-saved-views", tenantId] as const;
}

/**
 * `enabled` is the caller's scope answer. It is deliberately NOT defaulted
 * to true: `hasAuditReadScope` returns null while the scope probe is in
 * flight, and firing a guaranteed 403 during that window would put a red
 * error under a screen that is about to render a permission notice anyway.
 */
export function useAuditSavedViews(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: savedViewsKey(gate.tenantId),
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<AuditSavedView[]> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "GET",
        "/api/v1/audit/saved-views",
      );
      return normalizeSavedViews(res);
    },
  });
}

export interface SaveAuditViewInput {
  name: string;
  description: string;
  filters: Record<string, unknown>;
}

export function useSaveAuditView() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: SaveAuditViewInput): Promise<AuditSavedView> => {
      const { client } = getClient();
      const res = await client.request<unknown>(
        "POST",
        "/api/v1/audit/saved-views",
        {
          body: {
            name: input.name.trim(),
            description: input.description.trim(),
            filters: input.filters,
          },
        },
      );
      // POST answers with the bare row, so it normalises through the same
      // reader as the list — one row, or nothing if the shape surprised us.
      const [row] = normalizeSavedViews([res]);
      if (!row) throw new Error("The view was saved but came back unreadable.");
      return row;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: savedViewsKey(tenantId) });
    },
  });
}

export interface DeleteAuditViewResult {
  /** False when the server answered 404 — the row was already gone. */
  existed: boolean;
}

export function useDeleteAuditView() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (id: string): Promise<DeleteAuditViewResult> => {
      const { client } = getClient();
      try {
        await client.request<unknown>(
          "DELETE",
          `/api/v1/audit/saved-views/${encodeURIComponent(id)}`,
        );
        return { existed: true };
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          Number((err as { status?: unknown }).status) === 404
        ) {
          return { existed: false };
        }
        throw err;
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: savedViewsKey(tenantId) });
    },
  });
}
