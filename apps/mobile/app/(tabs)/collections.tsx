/**
 * Collections — the reference lookup tables this workspace keeps, their size,
 * and when each last changed.
 *
 * WHY THIS ROUTE IS `viewer` AND NOT `editor`, even though half the screen is
 * editor-only. The two reads are gated differently and the handler is where
 * that is visible:
 *
 *   GET /api/v1/collections       RequireScope(ScopeReadSubscribers)  (handlers.go:47)
 *   GET /api/v1/collections/{id}  RequireScope(ScopeWriteSubscribers) (handlers.go:48)
 *
 * `read:subscribers` is in the `readOnlyScopes` allowlist
 * (apikeys/middleware.go:332-337), so `requireAdminRoleForScopes` returns false
 * and the session-cookie path never reaches a role check (middleware.go:211-221)
 * — the CATALOGUE is readable by every role, viewer included.
 * `write:subscribers` is NOT in that allowlist, so one collection's ROWS run
 * through `sessionRoleAllowsScopes` (middleware.go:300-318), which admits owner,
 * admin and — because `write:subscribers` is in `editorWriteScopes`
 * (middleware.go:291-294) — editor. A viewer opening a row gets 403
 * `insufficient_role`. `routeauth/manifest.json` lists exactly this split
 * (viewer for the list, editor for the detail, both `review_status: "reviewed"`),
 * and the handler agrees.
 *
 * Registering the route at `editor` would therefore hide, from viewers, the one
 * part of this surface they are entitled to read. The row-level gate lives in
 * CollectionDetailPanel instead, said once and pre-emptively, so a viewer never
 * fires a request that can only 403.
 *
 * The three write routes (POST / PATCH / DELETE, handlers.go:49-51) are
 * deliberately not built — see the note at the top of CollectionsScreen.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { CollectionsScreen } from "@/components/collections/CollectionsScreen";

/**
 * Route-scoped boundary. A collection's rows are an arbitrary operator-authored
 * `map[string]any` (types.go:58) — heterogeneous keys, nested objects, 64 KiB
 * strings — so this screen renders one of the least predictable payloads in the
 * app, and a render throw must cost this tab rather than the whole shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function Collections() {
  return <CollectionsScreen />;
}
